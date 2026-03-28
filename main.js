"use strict";

const {
  ItemView,
  Modal,
  Notice,
  Plugin,
  PluginSettingTab,
  Setting,
  setIcon,
} = require("obsidian");
const { CaldavClient } = require("./caldav");
const { DEFAULT_TIMEZONE, FeishuApiClient } = require("./feishu-api");
const { formatEventRange } = require("./ics");

const VIEW_TYPE_FEISHU_CALENDAR = "feishu-calendar-view";

const DEFAULT_SETTINGS = {
  url: "",
  title: "飞书日历",
  apiBaseUrl: "https://open.feishu.cn",
  userAccessToken: "",
  apiCalendarId: "",
  apiCalendarName: "",
  serverUrl: "",
  username: "",
  password: "",
  selectedCalendarUrl: "",
  selectedCalendarName: "",
  discoveredCalendars: [],
  timezone: DEFAULT_TIMEZONE,
  defaultSidebarCollapsed: true,
  lastSuccessfulSyncAt: "",
};

function cloneCalendars(calendars) {
  return Array.isArray(calendars)
    ? calendars.map((item) => ({
        name: item.name || "(未命名日历)",
        collectionUrl: item.collectionUrl || "",
      }))
    : [];
}

class EventEditorModal extends Modal {
  constructor(app, options) {
    super(app);
    this.options = options;
    this.result = {
      summary: options.initial.summary || "",
      description: options.initial.description || "",
      allDay: Boolean(options.initial.allDay),
      start: options.initial.start || "",
      end: options.initial.end || "",
    };
  }

  onOpen() {
    const { contentEl, titleEl } = this;
    titleEl.setText(this.options.mode === "edit" ? "编辑飞书日程" : "新建飞书日程");
    contentEl.empty();
    contentEl.addClass("feishu-calendar-modal");

    new Setting(contentEl)
      .setName("标题")
      .addText((text) => {
        text.setValue(this.result.summary).onChange((value) => {
          this.result.summary = value;
        });
        text.inputEl.focus();
      });

    new Setting(contentEl)
      .setName("描述")
      .addTextArea((text) => {
        text.setValue(this.result.description).onChange((value) => {
          this.result.description = value;
        });
        text.inputEl.rows = 4;
      });

    new Setting(contentEl)
      .setName("全天")
      .addToggle((toggle) => {
        toggle.setValue(this.result.allDay).onChange((value) => {
          this.result.allDay = value;
          this.renderTimeInputs();
        });
      });

    this.timeContainer = contentEl.createDiv("feishu-calendar-modal-times");
    this.renderTimeInputs();

    const actions = contentEl.createDiv("feishu-calendar-modal-actions");
    const submitButton = actions.createEl("button", {
      cls: "mod-cta",
      text: this.options.mode === "edit" ? "保存" : "创建",
    });
    const cancelButton = actions.createEl("button", {
      text: "取消",
    });

    submitButton.addEventListener("click", async () => {
      const validationMessage = this.validate();
      if (validationMessage) {
        new Notice(validationMessage);
        return;
      }

      await this.options.onSubmit({
        summary: this.result.summary.trim() || "(无标题)",
        description: this.result.description.trim(),
        allDay: this.result.allDay,
        start: this.result.start,
        end: this.result.end,
      });
      this.close();
    });

    cancelButton.addEventListener("click", () => {
      this.close();
    });
  }

  renderTimeInputs() {
    this.timeContainer.empty();

    const inputType = this.result.allDay ? "date" : "datetime-local";
    const placeholderStart = this.result.allDay ? "开始日期" : "开始时间";
    const placeholderEnd = this.result.allDay ? "结束日期" : "结束时间";

    new Setting(this.timeContainer)
      .setName(placeholderStart)
      .addText((text) => {
        text.inputEl.type = inputType;
        text.setValue(this.result.start).onChange((value) => {
          this.result.start = value;
        });
      });

    new Setting(this.timeContainer)
      .setName(placeholderEnd)
      .addText((text) => {
        text.inputEl.type = inputType;
        text.setValue(this.result.end).onChange((value) => {
          this.result.end = value;
        });
      });
  }

  validate() {
    if (!this.result.start || !this.result.end) {
      return "请完整填写开始和结束时间。";
    }

    if (this.result.allDay) {
      if (this.result.end < this.result.start) {
        return "结束日期不能早于开始日期。";
      }
      return "";
    }

    const start = new Date(this.result.start);
    const end = new Date(this.result.end);
    if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) {
      return "请输入有效的日期时间。";
    }

    if (end <= start) {
      return "结束时间必须晚于开始时间。";
    }

    return "";
  }
}

class FeishuCalendarView extends ItemView {
  constructor(leaf, plugin) {
    super(leaf);
    this.plugin = plugin;
    this.webviewReady = false;
    this.sidebarSupported = false;
  }

  getViewType() {
    return VIEW_TYPE_FEISHU_CALENDAR;
  }

  getDisplayText() {
    return this.plugin.settings.title || "飞书日历";
  }

  getIcon() {
    return "calendar-days";
  }

  async onOpen() {
    this.contentEl.empty();
    this.contentEl.addClass("feishu-calendar-view");
    this.buildLayout();
    await this.refreshAll(false);
  }

  async onClose() {
    this.webviewReady = false;
  }

  buildLayout() {
    this.toolbarEl = this.contentEl.createDiv("feishu-calendar-toolbar");
    this.statusEl = this.contentEl.createDiv("feishu-calendar-status");
    const bodyEl = this.contentEl.createDiv("feishu-calendar-body");

    this.webPaneEl = bodyEl.createDiv("feishu-calendar-web-pane");
    this.eventsPaneEl = bodyEl.createDiv("feishu-calendar-events-pane");

    this.buildToolbar();
    this.buildWebPane();
    this.buildEventsPane();
  }

  buildToolbar() {
    const buttons = [
      {
        icon: "panel-left-open",
        label: "切换侧栏",
        onClick: async () => {
          await this.plugin.toggleSidebar();
        },
      },
      {
        icon: "plus",
        label: "新建日程",
        onClick: async () => {
          await this.plugin.openCreateEventModal();
        },
      },
      {
        icon: "refresh-cw",
        label: "立即同步",
        onClick: async () => {
          await this.plugin.syncEvents(true);
        },
      },
      {
        icon: "external-link",
        label: "浏览器打开",
        onClick: () => {
          const url = this.plugin.settings.url;
          if (!url) {
            new Notice("请先填写飞书日历链接。");
            return;
          }
          window.open(url, "_blank", "noopener");
        },
      },
    ];

    for (const button of buttons) {
      const buttonEl = this.toolbarEl.createEl("button", {
        cls: "feishu-calendar-toolbar-button",
        attr: {
          type: "button",
          "aria-label": button.label,
          title: button.label,
        },
      });
      setIcon(buttonEl, button.icon);
      buttonEl.createSpan({ text: button.label });
      buttonEl.addEventListener("click", () => {
        button.onClick();
      });
    }
  }

  buildWebPane() {
    this.webControlsEl = this.webPaneEl.createDiv("feishu-calendar-web-controls");
    this.webContainerEl = this.webPaneEl.createDiv("feishu-calendar-web-container");
    this.reloadWebview();
  }

  buildEventsPane() {
    const header = this.eventsPaneEl.createDiv("feishu-calendar-events-header");
    header.createEl("h3", { text: "近期日程" });

    const refreshButton = header.createEl("button", {
      cls: "feishu-calendar-icon-button",
      attr: {
        type: "button",
        title: "刷新日程",
      },
    });
    setIcon(refreshButton, "refresh-cw");
    refreshButton.addEventListener("click", async () => {
      await this.plugin.syncEvents(true);
    });

    this.eventsMetaEl = this.eventsPaneEl.createDiv("feishu-calendar-events-meta");
    this.eventsListEl = this.eventsPaneEl.createDiv("feishu-calendar-events-list");
  }

  reloadWebview() {
    this.webContainerEl.empty();
    this.webviewReady = false;
    this.sidebarSupported = false;

    const url = this.plugin.settings.url.trim();
    if (!url) {
      this.renderWebPlaceholder("请先在插件设置里填写飞书日历链接。");
      return;
    }

    const webview = document.createElement("webview");
    webview.className = "feishu-calendar-webview";
    webview.setAttribute("src", url);
    webview.setAttribute("partition", "persist:feishu-calendar");
    webview.setAttribute("allowpopups", "true");
    webview.setAttribute("webpreferences", "contextIsolation=yes");
    webview.addEventListener("dom-ready", async () => {
      this.webviewReady = true;
      await this.applySidebarPreference(false);
    });
    webview.addEventListener("did-navigate-in-page", async () => {
      await this.applySidebarPreference(false);
    });
    webview.addEventListener("did-finish-load", async () => {
      await this.applySidebarPreference(false);
    });
    webview.addEventListener("did-fail-load", () => {
      this.setStatus("飞书页面加载失败，请检查链接或登录状态。", "error");
    });

    this.webviewEl = webview;
    this.webContainerEl.appendChild(webview);
  }

  renderWebPlaceholder(message) {
    const placeholder = this.webContainerEl.createDiv("feishu-calendar-web-placeholder");
    placeholder.createEl("h3", { text: "飞书日历网页未配置" });
    placeholder.createEl("p", { text: message });
  }

  async refreshAll(notify) {
    this.reloadWebview();
    await this.plugin.syncEvents(notify);
  }

  async applySidebarPreference(notifyOnFailure) {
    if (!this.webviewEl || !this.webviewReady || typeof this.webviewEl.executeJavaScript !== "function") {
      return false;
    }

    const targetState = Boolean(this.plugin.settings.defaultSidebarCollapsed);
    const script = this.buildSidebarScript(targetState);

    try {
      const result = await this.webviewEl.executeJavaScript(script, true);
      this.sidebarSupported = Boolean(result && result.ok);

      if (!result || !result.ok) {
        if (notifyOnFailure) {
          new Notice("飞书页面结构发生变化，暂时无法自动切换侧栏。");
        }
        return false;
      }

      this.setStatus(targetState ? "已隐藏飞书网页侧栏。" : "已显示飞书网页侧栏。");
      return true;
    } catch (error) {
      if (notifyOnFailure) {
        new Notice("飞书页面结构发生变化，暂时无法自动切换侧栏。");
      }
      return false;
    }
  }

  buildSidebarScript(targetHidden) {
    return `
      (() => {
        const TARGET_HIDDEN = ${targetHidden ? "true" : "false"};

        function isVisible(el) {
          if (!el) return false;
          const rect = el.getBoundingClientRect();
          const style = window.getComputedStyle(el);
          return style.display !== "none" && style.visibility !== "hidden" && rect.width > 0 && rect.height > 0;
        }

        function textPreview(el) {
          return (el.innerText || "").replace(/\\s+/g, " ").slice(0, 240);
        }

        function scoreCandidate(el) {
          if (!isVisible(el)) return -1;
          const rect = el.getBoundingClientRect();
          if (rect.left > window.innerWidth * 0.35) return -1;
          if (rect.width < 160 || rect.width > 420) return -1;
          if (rect.height < window.innerHeight * 0.4) return -1;

          let score = 0;
          const text = textPreview(el);
          if (rect.left < 80) score += 3;
          if (rect.top < 220) score += 2;
          if (rect.height > window.innerHeight * 0.55) score += 2;
          if (/搜索联系人|会议室|我管理的|我订阅的|今天|周|月|日程/.test(text)) score += 9;
          if (/Teo|Phi/.test(text)) score += 3;
          if ((window.getComputedStyle(el).position || "") !== "fixed") score += 1;
          return score;
        }

        function findSidebar() {
          if (window.__obsidianFeishuSidebar && document.body.contains(window.__obsidianFeishuSidebar)) {
            return window.__obsidianFeishuSidebar;
          }

          let best = null;
          let bestScore = 0;
          const candidates = Array.from(document.querySelectorAll("div,aside,section"));
          for (const candidate of candidates) {
            const score = scoreCandidate(candidate);
            if (score > bestScore) {
              bestScore = score;
              best = candidate;
            }
          }

          if (!best || bestScore < 8) {
            return null;
          }

          window.__obsidianFeishuSidebar = best;
          return best;
        }

        function stashStyles(el) {
          if (el.dataset.obsidianFeishuSidebarOriginal) {
            return;
          }

          el.dataset.obsidianFeishuSidebarOriginal = JSON.stringify({
            width: el.style.width || "",
            minWidth: el.style.minWidth || "",
            maxWidth: el.style.maxWidth || "",
            flex: el.style.flex || "",
            flexBasis: el.style.flexBasis || "",
            overflow: el.style.overflow || "",
            marginRight: el.style.marginRight || "",
            opacity: el.style.opacity || "",
            pointerEvents: el.style.pointerEvents || "",
          });
        }

        function restoreStyles(el) {
          const raw = el.dataset.obsidianFeishuSidebarOriginal;
          if (!raw) {
            return;
          }

          const original = JSON.parse(raw);
          Object.assign(el.style, original);
        }

        const sidebar = findSidebar();
        if (!sidebar) {
          return { ok: false, reason: "sidebar-not-found", title: document.title };
        }

        stashStyles(sidebar);

        if (TARGET_HIDDEN) {
          sidebar.style.width = "0px";
          sidebar.style.minWidth = "0px";
          sidebar.style.maxWidth = "0px";
          sidebar.style.flex = "0 0 0px";
          sidebar.style.flexBasis = "0px";
          sidebar.style.overflow = "hidden";
          sidebar.style.marginRight = "0px";
          sidebar.style.opacity = "0";
          sidebar.style.pointerEvents = "none";
          sidebar.dataset.obsidianFeishuSidebarHidden = "1";
        } else {
          restoreStyles(sidebar);
          sidebar.dataset.obsidianFeishuSidebarHidden = "0";
        }

        return {
          ok: true,
          hidden: TARGET_HIDDEN,
          preview: textPreview(sidebar),
          width: sidebar.getBoundingClientRect().width,
        };
      })();
    `;
  }

  renderEvents(events) {
    this.eventsListEl.empty();
    this.eventsMetaEl.empty();

    const selectedCalendarName = this.plugin.getSelectedCalendarName();
    this.eventsMetaEl.createSpan({ text: `当前日历：${selectedCalendarName}` });
    this.eventsMetaEl.createSpan({ text: `当前连接：${this.plugin.getConnectionLabel()}` });

    if (this.plugin.settings.lastSuccessfulSyncAt) {
      const syncDate = new Date(this.plugin.settings.lastSuccessfulSyncAt);
      this.eventsMetaEl.createSpan({ text: `最近同步：${syncDate.toLocaleString()}` });
    }

    if (!events.length) {
      this.eventsListEl.createEl("p", {
        cls: "feishu-calendar-empty",
        text: "当前时间窗口内没有同步到日程。",
      });
      return;
    }

    for (const event of events) {
      const itemEl = this.eventsListEl.createDiv("feishu-calendar-event-item");
      const contentEl = itemEl.createDiv("feishu-calendar-event-content");
      contentEl.createEl("strong", {
        text: event.summary || "(无标题)",
      });
      contentEl.createEl("div", {
        cls: "feishu-calendar-event-range",
        text: formatEventRange(event),
      });

      if (event.description) {
        contentEl.createEl("div", {
          cls: "feishu-calendar-event-description",
          text: event.description,
        });
      }

      const actionsEl = itemEl.createDiv("feishu-calendar-event-actions");
      const editButton = actionsEl.createEl("button", {
        text: "编辑",
      });
      const deleteButton = actionsEl.createEl("button", {
        text: "删除",
      });

      editButton.addEventListener("click", async () => {
        await this.plugin.openEditEventModal(event);
      });

      deleteButton.addEventListener("click", async () => {
        if (!window.confirm(`确认删除“${event.summary || "(无标题)"}”吗？`)) {
          return;
        }
        await this.plugin.deleteEvent(event);
      });
    }
  }

  setStatus(message, kind = "info") {
    this.statusEl.setText(message || "");
    this.statusEl.dataset.kind = kind;
  }
}

class FeishuCalendarSettingTab extends PluginSettingTab {
  constructor(app, plugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display() {
    const { containerEl } = this;
    containerEl.empty();

    containerEl.createEl("h2", { text: "飞书日历插件设置" });

    new Setting(containerEl)
      .setName("飞书日历链接")
      .setDesc("用于在 Obsidian 内嵌显示的飞书日历网页地址。")
      .addText((text) => {
        text
          .setPlaceholder("https://example.feishu.cn/calendar/week")
          .setValue(this.plugin.settings.url)
          .onChange(async (value) => {
            this.plugin.settings.url = value.trim();
            await this.plugin.saveSettings();
          });
      });

    new Setting(containerEl)
      .setName("标签页标题")
      .setDesc("显示在 Obsidian 视图标题里的名称。")
      .addText((text) => {
        text
          .setPlaceholder("飞书日历")
          .setValue(this.plugin.settings.title)
          .onChange(async (value) => {
            this.plugin.settings.title = value.trim() || DEFAULT_SETTINGS.title;
            await this.plugin.saveSettings();
          });
      });

    new Setting(containerEl)
      .setName("默认隐藏网页侧栏")
      .setDesc("打开视图时，默认隐藏飞书网页内部的左侧栏。")
      .addToggle((toggle) => {
        toggle.setValue(this.plugin.settings.defaultSidebarCollapsed).onChange(async (value) => {
          this.plugin.settings.defaultSidebarCollapsed = value;
          await this.plugin.saveSettings();
        });
      });

    containerEl.createEl("h3", { text: "飞书 API（推荐）" });
    containerEl.createEl("p", {
      cls: "setting-item-description",
      text: `当前模式：${this.plugin.getConnectionLabel()}`,
    });

    new Setting(containerEl)
      .setName("飞书 user_access_token")
      .setDesc("填写后插件将优先使用飞书开放平台 API 做日程读写。Token 仅保存在当前 Vault 本地。")
      .addText((text) => {
        text.inputEl.type = "password";
        text
          .setPlaceholder("u-xxxxxxxx")
          .setValue(this.plugin.settings.userAccessToken)
          .onChange(async (value) => {
            this.plugin.settings.userAccessToken = value.trim();
            await this.plugin.saveSettings();
          });
      });

    new Setting(containerEl)
      .setName("飞书 API 基础地址")
      .setDesc("通常保持默认值即可。")
      .addText((text) => {
        text
          .setPlaceholder("https://open.feishu.cn")
          .setValue(this.plugin.settings.apiBaseUrl)
          .onChange(async (value) => {
            this.plugin.settings.apiBaseUrl = value.trim() || DEFAULT_SETTINGS.apiBaseUrl;
            await this.plugin.saveSettings();
          });
      });

    new Setting(containerEl)
      .setName("默认时区")
      .setDesc("用于通过飞书 API 创建和更新非全天日程。")
      .addText((text) => {
        text
          .setPlaceholder("Asia/Shanghai")
          .setValue(this.plugin.settings.timezone)
          .onChange(async (value) => {
            this.plugin.settings.timezone = value.trim() || DEFAULT_SETTINGS.timezone;
            await this.plugin.saveSettings();
          });
      });

    new Setting(containerEl)
      .setName("飞书 API 日历 ID")
      .setDesc("为空时可点击“读取主日历”自动填充，也可以手动填写共享日历 ID。")
      .addText((text) => {
        text
          .setPlaceholder("feishu.cn_xxx@group.calendar.feishu.cn")
          .setValue(this.plugin.settings.apiCalendarId)
          .onChange(async (value) => {
            this.plugin.settings.apiCalendarId = value.trim();
            await this.plugin.saveSettings();
          });
      });

    new Setting(containerEl)
      .setName("飞书 API 日历名称")
      .setDesc("用于界面展示，可由“读取主日历”自动更新。")
      .addText((text) => {
        text
          .setPlaceholder("主日历")
          .setValue(this.plugin.settings.apiCalendarName)
          .onChange(async (value) => {
            this.plugin.settings.apiCalendarName = value.trim();
            await this.plugin.saveSettings();
          });
      });

    new Setting(containerEl)
      .setName("读取主日历")
      .setDesc("验证当前 Token，并自动写入当前用户的主日历 ID。")
      .addButton((button) => {
        button.setButtonText("读取主日历").setCta().onClick(async () => {
          button.setDisabled(true);
          try {
            const calendar = await this.plugin.refreshApiCalendar();
            new Notice(`飞书 API 可用，当前主日历：${calendar.summary || calendar.calendarId}`);
            this.display();
          } catch (error) {
            new Notice(error.message || "读取主日历失败。");
          } finally {
            button.setDisabled(false);
          }
        });
      });

    containerEl.createEl("h3", { text: "CalDAV 连接" });

    new Setting(containerEl)
      .setName("CalDAV 服务器地址")
      .setDesc("例如 https://caldav.feishu.cn")
      .addText((text) => {
        text
          .setPlaceholder("https://caldav.feishu.cn")
          .setValue(this.plugin.settings.serverUrl)
          .onChange(async (value) => {
            this.plugin.settings.serverUrl = value.trim();
            await this.plugin.saveSettings();
          });
      });

    new Setting(containerEl)
      .setName("CalDAV 用户名")
      .addText((text) => {
        text
          .setPlaceholder("u_xxx")
          .setValue(this.plugin.settings.username)
          .onChange(async (value) => {
            this.plugin.settings.username = value.trim();
            await this.plugin.saveSettings();
          });
      });

    new Setting(containerEl)
      .setName("CalDAV 密码")
      .addText((text) => {
        text.inputEl.type = "password";
        text
          .setPlaceholder("输入飞书生成的 CalDAV 密码")
          .setValue(this.plugin.settings.password)
          .onChange(async (value) => {
            this.plugin.settings.password = value.trim();
            await this.plugin.saveSettings();
          });
      });

    new Setting(containerEl)
      .setName("测试连接")
      .setDesc("验证当前 CalDAV 配置，并自动发现可用日历。")
      .addButton((button) => {
        button.setButtonText("测试连接").setCta().onClick(async () => {
          button.setDisabled(true);
          try {
            const calendars = await this.plugin.refreshDiscoveredCalendars();
            new Notice(`连接成功，发现 ${calendars.length} 个日历。`);
            this.display();
          } catch (error) {
            new Notice(error.message || "连接失败。");
          } finally {
            button.setDisabled(false);
          }
        });
      });

    new Setting(containerEl)
      .setName("发现日历")
      .setDesc("重新读取当前账户下的日历列表。")
      .addButton((button) => {
        button.setButtonText("刷新日历").onClick(async () => {
          button.setDisabled(true);
          try {
            await this.plugin.refreshDiscoveredCalendars();
            this.display();
          } catch (error) {
            new Notice(error.message || "刷新日历失败。");
          } finally {
            button.setDisabled(false);
          }
        });
      });

    const discovered = cloneCalendars(this.plugin.settings.discoveredCalendars);
    const dropdownSetting = new Setting(containerEl)
      .setName("目标日历")
      .setDesc("选择插件读写的飞书日历。");

    dropdownSetting.addDropdown((dropdown) => {
      dropdown.addOption("", discovered.length ? "请选择目标日历" : "请先测试连接");
      for (const calendar of discovered) {
        dropdown.addOption(calendar.collectionUrl, calendar.name);
      }
      dropdown
        .setValue(this.plugin.settings.selectedCalendarUrl || "")
        .onChange(async (value) => {
          this.plugin.settings.selectedCalendarUrl = value;
          const matched = discovered.find((item) => item.collectionUrl === value);
          this.plugin.settings.selectedCalendarName = matched ? matched.name : "";
          await this.plugin.saveSettings();
        });
    });

    containerEl.createEl("h3", { text: "macOS Calendar.app" });

    new Setting(containerEl)
      .setName("复制 CalDAV 配置")
      .setDesc("复制一份可直接粘贴到 macOS 日历.app 的配置说明。")
      .addButton((button) => {
        button.setButtonText("复制配置").onClick(async () => {
          try {
            await navigator.clipboard.writeText(this.plugin.getMacCalendarConfigText());
            new Notice("已复制 macOS 日历配置。");
          } catch (error) {
            new Notice("复制失败，请检查系统剪贴板权限。");
          }
        });
      });
  }
}

module.exports = class FeishuCalendarPlugin extends Plugin {
  async onload() {
    await this.loadSettings();
    this.cachedEvents = [];

    this.registerView(
      VIEW_TYPE_FEISHU_CALENDAR,
      (leaf) => new FeishuCalendarView(leaf, this),
    );

    this.addRibbonIcon("calendar-days", "打开飞书日历", async () => {
      await this.openCalendarView();
    });

    this.addCommand({
      id: "open-feishu-calendar",
      name: "打开飞书日历",
      callback: async () => {
        await this.openCalendarView();
      },
    });

    this.addCommand({
      id: "toggle-feishu-sidebar",
      name: "切换飞书日历侧栏",
      callback: async () => {
        await this.toggleSidebar();
      },
    });

    this.addCommand({
      id: "create-feishu-event",
      name: "新建飞书日程",
      callback: async () => {
        await this.openCreateEventModal();
      },
    });

    this.addCommand({
      id: "sync-feishu-events",
      name: "立即同步飞书日程",
      callback: async () => {
        await this.syncEvents(true);
      },
    });

    this.addSettingTab(new FeishuCalendarSettingTab(this.app, this));
  }

  onunload() {
    this.app.workspace.detachLeavesOfType(VIEW_TYPE_FEISHU_CALENDAR);
  }

  async loadSettings() {
    const loaded = await this.loadData();
    this.settings = Object.assign({}, DEFAULT_SETTINGS, loaded || {});
    this.settings.discoveredCalendars = cloneCalendars(this.settings.discoveredCalendars);
  }

  async saveSettings() {
    await this.saveData({
      ...this.settings,
      discoveredCalendars: cloneCalendars(this.settings.discoveredCalendars),
    });
  }

  getClient() {
    return new CaldavClient(this.settings);
  }

  getApiClient() {
    return new FeishuApiClient(this.settings);
  }

  useApiMode() {
    return Boolean(String(this.settings.userAccessToken || "").trim());
  }

  getSelectedCalendarName() {
    if (this.useApiMode()) {
      return this.settings.apiCalendarName || this.settings.apiCalendarId || "未选择日历";
    }
    return this.settings.selectedCalendarName || "未选择日历";
  }

  getConnectionLabel() {
    if (this.useApiMode()) {
      return "飞书 API（读写）";
    }
    if (this.isReadOnlyMode()) {
      return "飞书 CalDAV（只读）";
    }
    return "CalDAV";
  }

  isReadOnlyMode() {
    return !this.useApiMode() && /caldav\.feishu\.cn/i.test(this.settings.serverUrl || "");
  }

  assertWritable() {
    if (this.isReadOnlyMode()) {
      throw new Error("飞书 CalDAV 当前实际为只读，写入会返回 409。若要创建、更新、删除日程，需要改用飞书 API 模式。");
    }
  }

  async openCalendarView() {
    let leaf = this.app.workspace.getLeavesOfType(VIEW_TYPE_FEISHU_CALENDAR)[0];
    if (!leaf) {
      try {
        leaf = this.app.workspace.getLeaf("tab");
      } catch (error) {
        leaf = this.app.workspace.getLeaf(true);
      }
      await leaf.setViewState({
        type: VIEW_TYPE_FEISHU_CALENDAR,
        active: true,
      });
    }

    this.app.workspace.revealLeaf(leaf);
    return leaf.view;
  }

  getOpenViews() {
    return this.app.workspace
      .getLeavesOfType(VIEW_TYPE_FEISHU_CALENDAR)
      .map((leaf) => leaf.view)
      .filter((view) => view instanceof FeishuCalendarView);
  }

  async refreshDiscoveredCalendars() {
    const client = this.getClient();
    const calendars = await client.discoverCalendars();
    this.settings.discoveredCalendars = cloneCalendars(calendars);

    if (!this.settings.selectedCalendarUrl && calendars.length > 0) {
      this.settings.selectedCalendarUrl = calendars[0].collectionUrl;
      this.settings.selectedCalendarName = calendars[0].name;
    } else if (this.settings.selectedCalendarUrl) {
      const matched = calendars.find((item) => item.collectionUrl === this.settings.selectedCalendarUrl);
      this.settings.selectedCalendarName = matched ? matched.name : calendars[0]?.name || "";
      if (!matched && calendars[0]) {
        this.settings.selectedCalendarUrl = calendars[0].collectionUrl;
      }
    }

    await this.saveSettings();
    return calendars;
  }

  async refreshApiCalendar() {
    const client = this.getApiClient();
    const calendar = await client.getPrimaryCalendar();
    this.settings.apiCalendarId = calendar.calendarId;
    this.settings.apiCalendarName = calendar.summary || calendar.calendarId;
    await this.saveSettings();
    return calendar;
  }

  async ensureCalendarReady() {
    if (this.useApiMode()) {
      if (!this.settings.apiCalendarId) {
        await this.refreshApiCalendar();
      }
      if (!this.settings.apiCalendarId) {
        throw new Error("当前 Token 下未找到可用飞书日历。");
      }
      return;
    }

    if (!this.settings.selectedCalendarUrl) {
      const calendars = await this.refreshDiscoveredCalendars();
      if (!calendars.length) {
        throw new Error("当前 CalDAV 账户下没有可用日历。");
      }
    }
  }

  async syncEvents(notify) {
    try {
      await this.ensureCalendarReady();
      const events = this.useApiMode()
        ? await this.getApiClient().listEvents(this.settings.apiCalendarId)
        : await this.getClient().listEvents(this.settings.selectedCalendarUrl);
      this.cachedEvents = events;
      this.settings.lastSuccessfulSyncAt = new Date().toISOString();
      await this.saveSettings();

      for (const view of this.getOpenViews()) {
        view.renderEvents(events);
        view.setStatus("飞书日程已同步。");
      }

      if (notify) {
        new Notice(`已同步 ${events.length} 条飞书日程。`);
      }

      return events;
    } catch (error) {
      for (const view of this.getOpenViews()) {
        view.setStatus(error.message || "同步失败。", "error");
      }
      if (notify) {
        new Notice(error.message || "同步失败。");
      }
      throw error;
    }
  }

  async toggleSidebar() {
    this.settings.defaultSidebarCollapsed = !this.settings.defaultSidebarCollapsed;
    await this.saveSettings();

    const views = this.getOpenViews();
    if (!views.length) {
      new Notice(this.settings.defaultSidebarCollapsed ? "已设为默认隐藏飞书侧栏。" : "已设为默认显示飞书侧栏。");
      return;
    }

    let applied = false;
    for (const view of views) {
      applied = (await view.applySidebarPreference(true)) || applied;
    }

    if (!applied) {
      new Notice("飞书页面结构发生变化，暂时无法自动切换侧栏。");
    }
  }

  buildEventDraft(initial = {}) {
    return {
      summary: initial.summary || "",
      description: initial.description || "",
      allDay: Boolean(initial.allDay),
      start: initial.start || "",
      end: initial.end || "",
    };
  }

  async openCreateEventModal() {
    try {
      await this.ensureCalendarReady();
      if (!this.useApiMode()) {
        this.assertWritable();
      }
    } catch (error) {
      new Notice(error.message || "请先完成飞书日历配置。");
      return;
    }

    const now = new Date();
    const start = new Date(now.getTime() + 30 * 60 * 1000);
    const end = new Date(start.getTime() + 60 * 60 * 1000);
    const initial = {
      summary: "",
      description: "",
      allDay: false,
      start: `${start.getFullYear()}-${String(start.getMonth() + 1).padStart(2, "0")}-${String(start.getDate()).padStart(2, "0")}T${String(start.getHours()).padStart(2, "0")}:${String(start.getMinutes()).padStart(2, "0")}`,
      end: `${end.getFullYear()}-${String(end.getMonth() + 1).padStart(2, "0")}-${String(end.getDate()).padStart(2, "0")}T${String(end.getHours()).padStart(2, "0")}:${String(end.getMinutes()).padStart(2, "0")}`,
    };

    new EventEditorModal(this.app, {
      mode: "create",
      initial,
      onSubmit: async (payload) => {
        if (this.useApiMode()) {
          await this.getApiClient().createEvent(this.settings.apiCalendarId, payload);
        } else {
          await this.getClient().createEvent(this.settings.selectedCalendarUrl, payload);
        }
        await this.syncEvents(false);
        new Notice("已创建飞书日程。");
      },
    }).open();
  }

  async openEditEventModal(event) {
    try {
      if (!this.useApiMode()) {
        this.assertWritable();
      }
    } catch (error) {
      new Notice(error.message || "当前连接为只读。");
      return;
    }

    new EventEditorModal(this.app, {
      mode: "edit",
      initial: this.buildEventDraft(event),
      onSubmit: async (payload) => {
        if (this.useApiMode()) {
          await this.getApiClient().updateEvent(this.settings.apiCalendarId, event.eventId, payload);
        } else {
          await this.getClient().updateEvent(event, payload);
        }
        await this.syncEvents(false);
        new Notice("已更新飞书日程。");
      },
    }).open();
  }

  async deleteEvent(event) {
    try {
      if (this.useApiMode()) {
        await this.getApiClient().deleteEvent(this.settings.apiCalendarId, event.eventId);
      } else {
        this.assertWritable();
        await this.getClient().deleteEvent(event);
      }
      await this.syncEvents(false);
      new Notice("已删除飞书日程。");
    } catch (error) {
      new Notice(error.message || "删除失败。");
      throw error;
    }
  }

  getMacCalendarConfigText() {
    return [
      "在 macOS 日历.app 中添加这个飞书 CalDAV 账户：",
      "",
      `服务器地址：${this.settings.serverUrl || "(未填写)"}`,
      `用户名：${this.settings.username || "(未填写)"}`,
      `密码：${this.settings.password ? "已在插件中保存，请手动复制当前密码" : "(未填写)"}`,
      `目标日历：${this.settings.selectedCalendarName || this.settings.apiCalendarName || "(未选择)"}`,
    ].join("\n");
  }
};
