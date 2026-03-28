"use strict";

const http = require("node:http");
const https = require("node:https");
const { randomUUID } = require("node:crypto");

const DEFAULT_BASE_URL = "https://open.feishu.cn";
const DEFAULT_TIMEZONE = "Asia/Shanghai";

function ensure(value, message) {
  if (!value) {
    throw new Error(message);
  }
}

function normalizeBaseUrl(input) {
  const value = input && String(input).trim() ? String(input).trim() : DEFAULT_BASE_URL;
  return /^https?:\/\//i.test(value) ? value : `https://${value}`;
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

function pad(value) {
  return String(value).padStart(2, "0");
}

function formatDateOnly(date) {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

function formatDateTimeLocal(date) {
  return `${formatDateOnly(date)}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function parseApiTime(timeInfo) {
  if (!timeInfo) {
    return null;
  }

  if (timeInfo.date) {
    return {
      allDay: true,
      value: String(timeInfo.date),
    };
  }

  if (!timeInfo.timestamp) {
    return null;
  }

  const date = new Date(Number(timeInfo.timestamp) * 1000);
  if (Number.isNaN(date.getTime())) {
    return null;
  }

  return {
    allDay: false,
    value: formatDateTimeLocal(date),
  };
}

function normalizeEvent(event) {
  const start = parseApiTime(event?.start_time);
  const end = parseApiTime(event?.end_time);
  if (!event?.event_id || !start || !end) {
    return null;
  }

  return {
    eventId: event.event_id,
    uid: event.event_id,
    summary: event.summary || "",
    description: event.description || "",
    allDay: Boolean(start.allDay),
    start: start.value,
    end: end.value,
    appLink: event.app_link || "",
    organizerCalendarId: event.organizer_calendar_id || "",
    raw: event,
  };
}

function compareEvents(left, right) {
  return String(left.start).localeCompare(String(right.start));
}

function buildTimeInfo(input, timezone) {
  if (input.allDay) {
    return {
      date: input.value,
      timezone: "UTC",
    };
  }

  const date = new Date(input.value);
  if (Number.isNaN(date.getTime())) {
    throw new Error("日程时间格式无效。");
  }

  return {
    timestamp: String(Math.floor(date.getTime() / 1000)),
    timezone: timezone || DEFAULT_TIMEZONE,
  };
}

function buildEventPayload(draft, options = {}) {
  const timezone = options.timezone || DEFAULT_TIMEZONE;
  const payload = {
    summary: draft.summary || "(无标题)",
    description: draft.description || "",
    need_notification: false,
    start_time: buildTimeInfo(
      {
        allDay: Boolean(draft.allDay),
        value: draft.start,
      },
      timezone,
    ),
    end_time: buildTimeInfo(
      {
        allDay: Boolean(draft.allDay),
        value: draft.end,
      },
      timezone,
    ),
  };

  if (options.includeDefaultVchat) {
    payload.vchat = {
      vc_type: "no_meeting",
    };
  }

  return payload;
}

class FeishuApiClient {
  constructor(settings) {
    this.baseUrl = normalizeBaseUrl(settings.apiBaseUrl);
    this.userAccessToken = String(settings.userAccessToken || "").trim();
    this.timezone = String(settings.timezone || DEFAULT_TIMEZONE).trim() || DEFAULT_TIMEZONE;
  }

  get authHeader() {
    ensure(this.userAccessToken, "缺少飞书 user_access_token。");
    return `Bearer ${this.userAccessToken}`;
  }

  buildUrl(pathname, query = {}) {
    const url = new URL(pathname, this.baseUrl);
    for (const [key, value] of Object.entries(query)) {
      if (value === undefined || value === null || value === "") {
        continue;
      }
      url.searchParams.set(key, String(value));
    }
    return url.href;
  }

  async request(pathname, options = {}) {
    const url = this.buildUrl(pathname, options.query);
    const body = options.body ? JSON.stringify(options.body) : null;
    const response = await requestRaw(url, {
      method: options.method || "GET",
      headers: {
        Authorization: this.authHeader,
        "Content-Type": "application/json; charset=utf-8",
        Locale: "zh_cn",
        ...(options.headers || {}),
      },
      body,
    });

    let parsed;
    try {
      parsed = response.text ? JSON.parse(response.text) : {};
    } catch (error) {
      throw new Error(`飞书 API 返回了无法解析的数据，HTTP ${response.status}`);
    }

    if (response.status < 200 || response.status >= 300) {
      const message = parsed?.msg || `HTTP ${response.status}`;
      throw new Error(`飞书 API 请求失败：${message}`);
    }

    if (parsed.code !== 0) {
      throw new Error(parsed.msg || `飞书 API 返回错误码 ${parsed.code}`);
    }

    return parsed.data || {};
  }

  async getPrimaryCalendar() {
    const data = await this.request("/open-apis/calendar/v4/calendars/primary", {
      method: "POST",
    });
    const item = Array.isArray(data.calendars) ? data.calendars[0] : null;
    const calendar = item?.calendar;
    ensure(calendar?.calendar_id, "未读取到主日历信息。");
    return {
      calendarId: calendar.calendar_id,
      summary: calendar.summary || "",
      type: calendar.type || "",
      role: calendar.role || "",
      isThirdParty: Boolean(calendar.is_third_party),
    };
  }

  async listEvents(calendarId, options = {}) {
    ensure(calendarId, "缺少飞书日历 ID。");
    const now = new Date();
    const daysBack = Number(options.daysBack ?? 30);
    const daysForward = Number(options.daysForward ?? 120);
    const rangeStart = new Date(now.getTime() - daysBack * 24 * 60 * 60 * 1000);
    const rangeEnd = new Date(now.getTime() + daysForward * 24 * 60 * 60 * 1000);
    const data = await this.request(`/open-apis/calendar/v4/calendars/${encodeURIComponent(calendarId)}/events`, {
      method: "GET",
      query: {
        page_size: 500,
        start_time: Math.floor(rangeStart.getTime() / 1000),
        end_time: Math.floor(rangeEnd.getTime() / 1000),
      },
    });

    return (Array.isArray(data.items) ? data.items : [])
      .map(normalizeEvent)
      .filter(Boolean)
      .sort(compareEvents);
  }

  async createEvent(calendarId, draft) {
    ensure(calendarId, "缺少飞书日历 ID。");
    const data = await this.request(`/open-apis/calendar/v4/calendars/${encodeURIComponent(calendarId)}/events`, {
      method: "POST",
      query: {
        idempotency_key: randomUUID(),
      },
      body: buildEventPayload(draft, {
        timezone: this.timezone,
        includeDefaultVchat: true,
      }),
    });

    return normalizeEvent(data.event);
  }

  async updateEvent(calendarId, eventId, draft) {
    ensure(calendarId, "缺少飞书日历 ID。");
    ensure(eventId, "缺少飞书日程 ID。");
    const data = await this.request(
      `/open-apis/calendar/v4/calendars/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(eventId)}`,
      {
        method: "PATCH",
        body: buildEventPayload(draft, {
          timezone: this.timezone,
        }),
      },
    );

    return normalizeEvent(data.event);
  }

  async deleteEvent(calendarId, eventId) {
    ensure(calendarId, "缺少飞书日历 ID。");
    ensure(eventId, "缺少飞书日程 ID。");
    await this.request(
      `/open-apis/calendar/v4/calendars/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(eventId)}`,
      {
        method: "DELETE",
      },
    );
  }
}

module.exports = {
  DEFAULT_TIMEZONE,
  FeishuApiClient,
};
