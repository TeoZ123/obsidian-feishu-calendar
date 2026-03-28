"use strict";

const http = require("node:http");
const https = require("node:https");
const { randomUUID } = require("node:crypto");
const { compareEvents, parseCalendarData, serializeEvent } = require("./ics");

const PRINCIPAL_PROPFIND_BODY = `<?xml version="1.0" encoding="utf-8" ?>
<d:propfind xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav">
  <d:prop>
    <d:current-user-principal />
    <c:calendar-home-set />
  </d:prop>
</d:propfind>`;

const HOME_PROPFIND_BODY = `<?xml version="1.0" encoding="utf-8" ?>
<d:propfind xmlns:d="DAV:">
  <d:prop>
    <d:displayname />
    <d:resourcetype />
  </d:prop>
</d:propfind>`;

function buildCalendarQueryBody(startUtc, endUtc) {
  return `<?xml version="1.0" encoding="utf-8" ?>
<c:calendar-query xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav">
  <d:prop>
    <d:getetag />
    <c:calendar-data />
  </d:prop>
  <c:filter>
    <c:comp-filter name="VCALENDAR">
      <c:comp-filter name="VEVENT">
        <c:time-range start="${startUtc}" end="${endUtc}" />
      </c:comp-filter>
    </c:comp-filter>
  </c:filter>
</c:calendar-query>`;
}

function ensure(value, message) {
  if (!value) {
    throw new Error(message);
  }
}

function normalizeBaseUrl(input) {
  ensure(input, "缺少 CalDAV 服务器地址。");
  const value = /^https?:\/\//i.test(input) ? input : `https://${input}`;
  return new URL(value);
}

function basicAuth(username, password) {
  return `Basic ${Buffer.from(`${username}:${password}`, "utf8").toString("base64")}`;
}

function decodeXml(value) {
  return String(value ?? "")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
}

function stripXml(value) {
  return String(value ?? "").replace(/<[^>]+>/g, "").trim();
}

function extractFirstTagBlock(xml, tagName) {
  const regex = new RegExp(`<(?:[\\w-]+:)?${tagName}\\b[^>]*>([\\s\\S]*?)<\\/(?:[\\w-]+:)?${tagName}>`, "i");
  const match = String(xml ?? "").match(regex);
  return match ? match[1] : null;
}

function extractResponses(xml) {
  return Array.from(
    String(xml ?? "").matchAll(/<(?:[\w-]+:)?response\b[\s\S]*?<\/(?:[\w-]+:)?response>/gi),
    (match) => match[0],
  );
}

function extractFirstHrefFromTag(xml, tagName) {
  const block = extractFirstTagBlock(xml, tagName);
  if (!block) {
    return null;
  }

  const hrefMatch = block.match(/<(?:[\w-]+:)?href\b[^>]*>([\s\S]*?)<\/(?:[\w-]+:)?href>/i);
  return hrefMatch ? decodeXml(stripXml(hrefMatch[1])) : null;
}

function isCalendarResource(responseXml) {
  const resourceTypeBlock = extractFirstTagBlock(responseXml, "resourcetype");
  return Boolean(resourceTypeBlock && /<(?:[\w-]+:)?calendar\b/i.test(resourceTypeBlock));
}

function parseCalendars(xml, baseUrl) {
  const responses = extractResponses(xml);
  const seen = new Set();
  const calendars = [];

  for (const response of responses) {
    if (!isCalendarResource(response)) {
      continue;
    }

    const hrefBlock = extractFirstTagBlock(response, "href");
    if (!hrefBlock) {
      continue;
    }

    const href = decodeXml(stripXml(hrefBlock));
    const nameBlock = extractFirstTagBlock(response, "displayname");
    const name = nameBlock ? decodeXml(stripXml(nameBlock)) : "(未命名日历)";
    const collectionUrl = new URL(href, baseUrl).href;

    if (seen.has(collectionUrl)) {
      continue;
    }

    seen.add(collectionUrl);
    calendars.push({
      name,
      collectionUrl,
      href,
    });
  }

  return calendars;
}

function parseEventResponses(xml, baseUrl) {
  const responses = extractResponses(xml);
  const events = [];

  for (const response of responses) {
    const hrefBlock = extractFirstTagBlock(response, "href");
    const etagBlock = extractFirstTagBlock(response, "getetag");
    const dataBlock = extractFirstTagBlock(response, "calendar-data");
    if (!hrefBlock || !dataBlock) {
      continue;
    }

    const href = decodeXml(stripXml(hrefBlock));
    const etag = etagBlock ? decodeXml(stripXml(etagBlock)) : "";
    const rawCalendarData = decodeXml(dataBlock);
    const parsed = parseCalendarData(rawCalendarData);
    if (!parsed) {
      continue;
    }

    events.push({
      ...parsed,
      resourceUrl: new URL(href, baseUrl).href,
      etag,
    });
  }

  return events.sort(compareEvents);
}

function formatUtcForCaldav(date) {
  const pad = (value) => String(value).padStart(2, "0");
  return [
    date.getUTCFullYear(),
    pad(date.getUTCMonth() + 1),
    pad(date.getUTCDate()),
    "T",
    pad(date.getUTCHours()),
    pad(date.getUTCMinutes()),
    pad(date.getUTCSeconds()),
    "Z",
  ].join("");
}

function normalizeHeaders(headers) {
  const normalized = {};
  for (const [key, value] of Object.entries(headers ?? {})) {
    normalized[key.toLowerCase()] = value;
  }
  return normalized;
}

function readHeader(headers, name) {
  return normalizeHeaders(headers)[String(name).toLowerCase()] ?? "";
}

function requestRaw(url, options, redirectCount = 0) {
  const {
    method = "GET",
    headers = {},
    body = null,
  } = options ?? {};

  return new Promise((resolve, reject) => {
    const target = new URL(url);
    const transport = target.protocol === "http:" ? http : https;
    const payload = body ? Buffer.from(body, "utf8") : null;
    const request = transport.request(
      target,
      {
        method,
        headers: {
          ...headers,
          ...(payload ? { "Content-Length": String(payload.length) } : {}),
        },
      },
      (response) => {
        const chunks = [];
        response.on("data", (chunk) => chunks.push(chunk));
        response.on("end", async () => {
          const text = Buffer.concat(chunks).toString("utf8");
          const headersObject = response.headers || {};
          const status = response.statusCode || 0;

          if ([301, 302, 307, 308].includes(status) && headersObject.location && redirectCount < 5) {
            try {
              const nextUrl = new URL(headersObject.location, target).href;
              const redirected = await requestRaw(nextUrl, options, redirectCount + 1);
              resolve(redirected);
              return;
            } catch (error) {
              reject(error);
              return;
            }
          }

          resolve({
            status,
            headers: headersObject,
            text,
          });
        });
      },
    );

    request.on("error", reject);

    if (payload) {
      request.write(payload);
    }

    request.end();
  });
}

class CaldavClient {
  constructor(settings) {
    this.serverUrl = settings.serverUrl;
    this.username = settings.username;
    this.password = settings.password;
  }

  get authHeader() {
    ensure(this.username, "缺少 CalDAV 用户名。");
    ensure(this.password, "缺少 CalDAV 密码。");
    return basicAuth(this.username, this.password);
  }

  async request(url, method, headers = {}, body = null) {
    return requestRaw(url, {
      method,
      headers: {
        Authorization: this.authHeader,
        ...headers,
      },
      body,
    });
  }

  async discoverCalendarHome() {
    const baseUrl = normalizeBaseUrl(this.serverUrl);
    const candidates = [
      new URL(baseUrl.href),
      new URL("/.well-known/caldav", baseUrl.href),
    ];
    const seen = new Set();

    for (const candidate of candidates) {
      if (seen.has(candidate.href)) {
        continue;
      }
      seen.add(candidate.href);

      const principalResponse = await this.request(candidate.href, "PROPFIND", {
        Depth: "0",
        "Content-Type": "application/xml; charset=utf-8",
      }, PRINCIPAL_PROPFIND_BODY);

      if (principalResponse.status >= 400) {
        continue;
      }

      let calendarHomeHref = extractFirstHrefFromTag(principalResponse.text, "calendar-home-set");
      if (calendarHomeHref) {
        return new URL(calendarHomeHref, candidate.href);
      }

      const principalHref = extractFirstHrefFromTag(principalResponse.text, "current-user-principal");
      if (!principalHref) {
        continue;
      }

      const principalUrl = new URL(principalHref, candidate.href);
      const homeResponse = await this.request(principalUrl.href, "PROPFIND", {
        Depth: "0",
        "Content-Type": "application/xml; charset=utf-8",
      }, PRINCIPAL_PROPFIND_BODY);

      if (homeResponse.status >= 400) {
        continue;
      }

      calendarHomeHref = extractFirstHrefFromTag(homeResponse.text, "calendar-home-set");
      if (calendarHomeHref) {
        return new URL(calendarHomeHref, principalUrl.href);
      }
    }

    throw new Error("无法从该 CalDAV 地址发现日历目录。");
  }

  async discoverCalendars() {
    const calendarHomeUrl = await this.discoverCalendarHome();
    const response = await this.request(calendarHomeUrl.href, "PROPFIND", {
      Depth: "1",
      "Content-Type": "application/xml; charset=utf-8",
    }, HOME_PROPFIND_BODY);

    if (response.status >= 400) {
      throw new Error(`读取日历列表失败，HTTP ${response.status}`);
    }

    return parseCalendars(response.text, calendarHomeUrl.href);
  }

  async listEvents(calendarUrl, options = {}) {
    ensure(calendarUrl, "未选择目标日历。");
    const now = new Date();
    const daysBack = Number(options.daysBack ?? 30);
    const daysForward = Number(options.daysForward ?? 120);
    const rangeStart = new Date(now.getTime() - daysBack * 24 * 60 * 60 * 1000);
    const rangeEnd = new Date(now.getTime() + daysForward * 24 * 60 * 60 * 1000);

    const response = await this.request(calendarUrl, "REPORT", {
      Depth: "1",
      "Content-Type": "application/xml; charset=utf-8",
    }, buildCalendarQueryBody(formatUtcForCaldav(rangeStart), formatUtcForCaldav(rangeEnd)));

    if (response.status >= 400) {
      throw new Error(`读取日程失败，HTTP ${response.status}`);
    }

    return parseEventResponses(response.text, calendarUrl);
  }

  async createEvent(calendarUrl, eventInput) {
    ensure(calendarUrl, "未选择目标日历。");
    const uid = randomUUID();
    const resourceUrl = new URL(`${uid}.ics`, calendarUrl).href;
    const ics = serializeEvent({
      ...eventInput,
      uid,
      sequence: 0,
    });
    const response = await this.request(resourceUrl, "PUT", {
      "Content-Type": "text/calendar; charset=utf-8",
      "If-None-Match": "*",
    }, ics);

    if (response.status < 200 || response.status >= 300) {
      throw new Error(`创建日程失败，HTTP ${response.status} ${response.text ? `body=${response.text.slice(0, 300)}` : ""}`.trim());
    }

    return {
      uid,
      resourceUrl,
      etag: readHeader(response.headers, "etag"),
    };
  }

  async updateEvent(event, eventInput) {
    ensure(event?.resourceUrl, "缺少日程资源地址，无法更新。");
    const ics = serializeEvent({
      ...eventInput,
      uid: event.uid,
      sequence: Number(event.sequence ?? 0) + 1,
    });
    const headers = {
      "Content-Type": "text/calendar; charset=utf-8",
    };

    if (event.etag) {
      headers["If-Match"] = event.etag;
    }

    const response = await this.request(event.resourceUrl, "PUT", headers, ics);
    if (response.status < 200 || response.status >= 300) {
      throw new Error(`更新日程失败，HTTP ${response.status} ${response.text ? `body=${response.text.slice(0, 300)}` : ""}`.trim());
    }

    return {
      ...event,
      etag: readHeader(response.headers, "etag") || event.etag,
      sequence: Number(event.sequence ?? 0) + 1,
    };
  }

  async deleteEvent(event) {
    ensure(event?.resourceUrl, "缺少日程资源地址，无法删除。");
    const headers = {};

    if (event.etag) {
      headers["If-Match"] = event.etag;
    }

    const response = await this.request(event.resourceUrl, "DELETE", headers);
    if (response.status < 200 || response.status >= 300) {
      throw new Error(`删除日程失败，HTTP ${response.status} ${response.text ? `body=${response.text.slice(0, 300)}` : ""}`.trim());
    }
  }
}

module.exports = {
  CaldavClient,
};
