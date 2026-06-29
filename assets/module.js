(function() {
  const BACKEND_URL = "https://script.google.com/macros/s/AKfycbxDY5TsonrB58YaN8LGbrrrc_ZD1QVpF1WK0p6jToIR2FBSqGaHfsgaE1CCiH1MvukV/exec";
  const SESSION_KEY = "techgeekph_session";
  const config = window.MODULE_CONFIG || {};
  let records = [];

  const fields = {
    notice: document.querySelector("#notice"),
    avatar: document.querySelector("#avatar"),
    userName: document.querySelector("#userName"),
    userRole: document.querySelector("#userRole"),
    rows: document.querySelector("#moduleRows"),
    searchInput: document.querySelector("#searchInput"),
    statusFilter: document.querySelector("#statusFilter"),
    refreshBtn: document.querySelector("#refreshBtn"),
    logoutBtn: document.querySelector("#logoutBtn"),
    draftForm: document.querySelector("#draftForm")
  };

  function loadSession() {
    try {
      return JSON.parse(localStorage.getItem(SESSION_KEY) || "{}");
    } catch (error) {
      return {};
    }
  }

  function initialsFrom(value) {
    return String(value || "TG")
      .replace(/@.*/, "")
      .split(/[.\s_-]+/)
      .filter(Boolean)
      .slice(0, 2)
      .map(function(part) { return part[0].toUpperCase(); })
      .join("") || "TG";
  }

  function setUser(session) {
    const user = session.user || {};
    const name = user.name || user.email || session.email || "TechGeekPH User";
    const role = user.role || session.role || "portal";

    fields.userName.textContent = name;
    fields.userRole.textContent = role.charAt(0).toUpperCase() + role.slice(1) + " access";
    fields.avatar.textContent = initialsFrom(name);
  }

  function normalize(value) {
    return String(value || "").trim().toLowerCase();
  }

  function escapeHtml(value) {
    return String(value || "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  function getValue(row, keys) {
    for (let index = 0; index < keys.length; index += 1) {
      const key = keys[index];
      if (row && Object.prototype.hasOwnProperty.call(row, key)) return row[key];
    }
    return "";
  }

  function getStatus(row) {
    return getValue(row, config.statusKeys || ["status", "Status"]);
  }

  function getPriority(row) {
    return getValue(row, ["priority", "Priority"]);
  }

  function formatMetric(value, type) {
    if (value === undefined || value === null || value === "") return "--";
    const number = Number(value);
    if (!Number.isFinite(number)) return String(value);
    if (type === "currency") return "PHP " + number.toLocaleString();
    return number.toLocaleString();
  }

  function computeMetric(metric) {
    if (metric.type === "total") return records.length;
    if (metric.type === "status") {
      const wanted = (metric.statuses || []).map(normalize);
      return records.filter(function(row) {
        return wanted.indexOf(normalize(getStatus(row))) !== -1;
      }).length;
    }
    if (metric.type === "priority") {
      const wanted = (metric.values || []).map(normalize);
      return records.filter(function(row) {
        return wanted.indexOf(normalize(getPriority(row))) !== -1;
      }).length;
    }
    if (metric.type === "sum") {
      return records.reduce(function(total, row) {
        return total + Number(getValue(row, metric.keys || []) || 0);
      }, 0);
    }
    if (metric.type === "stockValue") {
      return records.reduce(function(total, row) {
        const stock = Number(getValue(row, ["stock", "Stock"]) || 0);
        const price = Number(getValue(row, ["price", "Price"]) || 0);
        return total + stock * price;
      }, 0);
    }
    if (metric.type === "lowStock") {
      return records.filter(function(row) {
        const status = normalize(getStatus(row));
        const stock = Number(getValue(row, ["stock", "Stock"]) || 0);
        const minStock = Number(getValue(row, ["minstock", "Min Stock"]) || 0);
        return status === "low stock" || status === "out of stock" || stock <= minStock;
      }).length;
    }
    if (metric.type === "today") {
      const today = new Date().toISOString().slice(0, 10);
      return records.filter(function(row) {
        return String(getValue(row, metric.keys || []) || "").slice(0, 10) === today;
      }).length;
    }
    return "--";
  }

  function setMetrics() {
    (config.metrics || []).forEach(function(metric, index) {
      const target = document.querySelector("#metric" + index);
      if (!target) return;
      target.textContent = formatMetric(computeMetric(metric), metric.format);
    });
  }

  function rowText(row) {
    return Object.keys(row || {}).map(function(key) {
      return row[key];
    }).join(" ").toLowerCase();
  }

  function filteredRows() {
    const query = normalize(fields.searchInput && fields.searchInput.value);
    const status = normalize(fields.statusFilter && fields.statusFilter.value);

    return records.filter(function(row) {
      const matchesQuery = !query || rowText(row).indexOf(query) !== -1;
      const matchesStatus = !status || normalize(getStatus(row)) === status;
      return matchesQuery && matchesStatus;
    });
  }

  function statusClass(status) {
    const value = normalize(status);
    if (value.includes("pending") || value.includes("assigned") || value.includes("ongoing") || value.includes("for") || value.includes("break")) return "is-warn";
    if (value.includes("cancel") || value.includes("disconnect") || value.includes("out") || value.includes("reject")) return "is-alert";
    return "";
  }

  function renderRows() {
    const rows = filteredRows();
    setMetrics();

    if (!rows.length) {
      fields.rows.innerHTML = '<tr><td colspan="' + config.columns.length + '">No ' + escapeHtml(config.sheetName || "module") + ' records to show yet.</td></tr>';
      return;
    }

    fields.rows.innerHTML = rows.map(function(row) {
      return "<tr>" + config.columns.map(function(column) {
        const value = getValue(row, column.keys || []);
        if (column.type === "status") {
          return '<td><span class="status ' + statusClass(value) + '">' + escapeHtml(value || column.empty || "Open") + "</span></td>";
        }
        if (column.type === "currency") {
          return "<td>" + escapeHtml(formatMetric(value || 0, "currency")) + "</td>";
        }
        return "<td>" + escapeHtml(value || column.empty || "") + "</td>";
      }).join("") + "</tr>";
    }).join("");
  }

  async function callBackend(action, payload) {
    const body = new URLSearchParams();
    body.set("action", action);
    body.set("method", action);
    Object.keys(payload || {}).forEach(function(key) {
      body.set(key, payload[key]);
    });

    const response = await fetch(BACKEND_URL, {
      method: "POST",
      body: body,
      redirect: "follow"
    });
    const text = await response.text();
    const type = response.headers.get("content-type") || "";

    if (type.indexOf("application/json") !== -1 || /^[\s\r\n]*[\[{]/.test(text)) {
      return JSON.parse(text);
    }

    if (/<html[\s>]/i.test(text) || /sandboxFrame/i.test(text)) {
      return {
        ok: false,
        htmlResponse: true,
        message: "Apps Script returned HTML instead of JSON."
      };
    }

    return { ok: false, message: text.trim() || "Unexpected response." };
  }

  function setConnectionState(ok, message) {
    return { ok: ok, message: message };
  }

  function showNotice(message) {
    fields.notice.textContent = message;
    fields.notice.classList.remove("is-hidden");
  }

  function hideNotice() {
    fields.notice.textContent = "";
    fields.notice.classList.add("is-hidden");
  }

  async function loadRows() {
    const session = loadSession();
    setConnectionState(false, "Loading " + config.sheetName + " records...");

    try {
      const response = await callBackend("getSheetRows", {
        sheetName: config.sheetName,
        role: (session.user && session.user.role) || session.role || "admin"
      });

      if (!response || !response.ok) {
        records = [];
        setConnectionState(false, "Connection pending");
        hideNotice();
        renderRows();
        return;
      }

      records = response.rows || [];
      setConnectionState(true, "Live " + config.sheetName + " sheet connected");
      fields.notice.classList.add("is-hidden");
      renderRows();
    } catch (error) {
      records = [];
      setConnectionState(false, "Connection unavailable");
      hideNotice();
      renderRows();
    }
  }

  function bindEvents() {
    if (fields.searchInput) fields.searchInput.addEventListener("input", renderRows);
    if (fields.statusFilter) fields.statusFilter.addEventListener("change", renderRows);
    if (fields.refreshBtn) fields.refreshBtn.addEventListener("click", loadRows);
    if (fields.draftForm) {
      fields.draftForm.addEventListener("submit", function(event) {
        event.preventDefault();
        showNotice(config.draftMessage || "Draft captured on this page. Save API can be wired next.");
      });
    }
    if (fields.logoutBtn) {
      fields.logoutBtn.addEventListener("click", function() {
        localStorage.removeItem(SESSION_KEY);
        window.location.href = "index.html";
      });
    }
  }

  setUser(loadSession());
  bindEvents();
  loadRows();
})();
