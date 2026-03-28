"use strict";

function unfoldLines(text) {
  return text.replace(/\r?\n[ \t]/g, "");
}

function splitLines(text) {
  return unfoldLines(text)
    .split(/\r?\n/)
    .map((line) => line.trimEnd())
    .filter((line) => line.length > 0);
}

function parseContentLine(line) {
  const separatorIndex = line.indexOf(":");
  if (separatorIndex === -1) {
    return null;
  }

  const rawName = line.slice(0, separatorIndex);
  const value = line.slice(separatorIndex + 1);
  const parts = rawName.split(";");
  const name = parts.shift().toUpperCase();
  const params = {};

  for (const part of parts) {
    const [paramName, paramValue = ""] = part.split("=");
    params[paramName.toUpperCase()] = paramValue;
  }

  return {
    name,
    params,
    value,
  };
}

function escapeText(value) {
  return String(value ?? "")
    .replace(/\\/g, "\\\\")
    .replace(/\n/g, "\\n")
    .replace(/;/g, "\\;")
    .replace(/,/g, "\\,");
}

function unescapeText(value) {
  return String(value ?? "")
    .replace(/\\n/gi, "\n")
    .replace(/\\,/g, ",")
    .replace(/\\;/g, ";")
    .replace(/\\\\/g, "\\");
}

function pad(value) {
  return String(value).padStart(2, "0");
}

function formatDateOnly(date) {
  const year = date.getFullYear();
  const month = pad(date.getMonth() + 1);
  const day = pad(date.getDate());
  return `${year}-${month}-${day}`;
}

function formatDateTimeLocal(date) {
  return `${formatDateOnly(date)}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function formatUtcStamp(date) {
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

function formatDateValue(value) {
  return value.replace(/-/g, "");
}

function parseBasicDate(value) {
  const year = Number(value.slice(0, 4));
  const month = Number(value.slice(4, 6)) - 1;
  const day = Number(value.slice(6, 8));
  return new Date(year, month, day);
}

function parseBasicDateTime(value, isUtc) {
  const year = Number(value.slice(0, 4));
  const month = Number(value.slice(4, 6)) - 1;
  const day = Number(value.slice(6, 8));
  const hour = Number(value.slice(9, 11));
  const minute = Number(value.slice(11, 13));
  const second = Number(value.slice(13, 15) || "0");

  if (isUtc) {
    return new Date(Date.UTC(year, month, day, hour, minute, second));
  }

  return new Date(year, month, day, hour, minute, second);
}

function parseDateField(value, params) {
  if (!value) {
    return null;
  }

  const isAllDay = params.VALUE === "DATE" || /^\d{8}$/.test(value);
  if (isAllDay) {
    const date = parseBasicDate(value);
    return {
      allDay: true,
      value: formatDateOnly(date),
    };
  }

  const isUtc = value.endsWith("Z");
  const normalized = isUtc ? value.slice(0, -1) : value;
  const date = parseBasicDateTime(normalized, isUtc);
  return {
    allDay: false,
    value: formatDateTimeLocal(date),
  };
}

function addDays(dateString, offsetDays) {
  const date = new Date(`${dateString}T00:00:00`);
  date.setDate(date.getDate() + offsetDays);
  return formatDateOnly(date);
}

function parseCalendarData(icsText) {
  const lines = splitLines(icsText);
  let inEvent = false;
  const event = {
    sequence: 0,
  };

  for (const line of lines) {
    if (line === "BEGIN:VEVENT") {
      inEvent = true;
      continue;
    }

    if (line === "END:VEVENT") {
      break;
    }

    if (!inEvent) {
      continue;
    }

    const parsed = parseContentLine(line);
    if (!parsed) {
      continue;
    }

    switch (parsed.name) {
      case "UID":
        event.uid = parsed.value;
        break;
      case "SUMMARY":
        event.summary = unescapeText(parsed.value);
        break;
      case "DESCRIPTION":
        event.description = unescapeText(parsed.value);
        break;
      case "SEQUENCE":
        event.sequence = Number(parsed.value || 0) || 0;
        break;
      case "DTSTART":
        event.start = parseDateField(parsed.value, parsed.params);
        break;
      case "DTEND":
        event.end = parseDateField(parsed.value, parsed.params);
        break;
      default:
        break;
    }
  }

  if (!event.uid || !event.start) {
    return null;
  }

  const allDay = Boolean(event.start.allDay);
  const endValue = event.end ? event.end.value : event.start.value;
  const normalizedEnd = allDay ? addDays(endValue, -1) : endValue;

  return {
    uid: event.uid,
    summary: event.summary ?? "",
    description: event.description ?? "",
    allDay,
    start: event.start.value,
    end: normalizedEnd,
    sequence: event.sequence ?? 0,
  };
}

function serializeEvent(input) {
  const now = new Date();
  const sequence = Number(input.sequence ?? 0) || 0;
  const lines = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//teo_z//Obsidian Feishu Calendar//CN",
    "CALSCALE:GREGORIAN",
    "BEGIN:VEVENT",
    `UID:${input.uid}`,
    `DTSTAMP:${formatUtcStamp(now)}`,
    `LAST-MODIFIED:${formatUtcStamp(now)}`,
    `SEQUENCE:${sequence}`,
    `SUMMARY:${escapeText(input.summary || "(无标题)")}`,
    `DESCRIPTION:${escapeText(input.description || "")}`,
  ];

  if (input.allDay) {
    lines.push(`DTSTART;VALUE=DATE:${formatDateValue(input.start)}`);
    lines.push(`DTEND;VALUE=DATE:${formatDateValue(addDays(input.end, 1))}`);
  } else {
    const startDate = new Date(input.start);
    const endDate = new Date(input.end);
    lines.push(`DTSTART:${formatUtcStamp(startDate)}`);
    lines.push(`DTEND:${formatUtcStamp(endDate)}`);
  }

  lines.push("END:VEVENT", "END:VCALENDAR");
  return `${lines.join("\r\n")}\r\n`;
}

function formatEventRange(event) {
  if (event.allDay) {
    return `${event.start} 全天`;
  }

  const start = new Date(event.start);
  const end = new Date(event.end);
  const startLabel = `${formatDateOnly(start)} ${pad(start.getHours())}:${pad(start.getMinutes())}`;
  const endLabel = `${formatDateOnly(end)} ${pad(end.getHours())}:${pad(end.getMinutes())}`;
  return `${startLabel} - ${endLabel}`;
}

function compareEvents(left, right) {
  return String(left.start).localeCompare(String(right.start));
}

module.exports = {
  compareEvents,
  formatDateOnly,
  formatDateTimeLocal,
  formatEventRange,
  parseCalendarData,
  serializeEvent,
};
