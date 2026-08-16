/* E-Rakshak Pinpoint — session auth + API wrapper (no frameworks) */

window.AUTH = (() => {
  const TOKEN_KEY = "pt_session_token";
  const USER_KEY = "pt_session_user";

  let token = localStorage.getItem(TOKEN_KEY) || "";
  let user = null;

  function setToken(t) {
    token = t || "";
    if (t) localStorage.setItem(TOKEN_KEY, t);
    else localStorage.removeItem(TOKEN_KEY);
  }

  function setUser(u) {
    user = u || null;
    if (u) localStorage.setItem(USER_KEY, JSON.stringify(u));
    else localStorage.removeItem(USER_KEY);
  }

  function getUser() {
    if (user) return user;
    try {
      user = JSON.parse(localStorage.getItem(USER_KEY) || "null");
    } catch (_) {
      user = null;
    }
    return user;
  }

  /** fetch wrapper with bearer token + 401 handling. */
  async function api(path, opts = {}) {
    const headers = Object.assign({}, opts.headers || {});
    if (token) headers["Authorization"] = `Bearer ${token}`;
    if (opts.body && typeof opts.body === "object" && !(opts.body instanceof FormData)) {
      headers["Content-Type"] = "application/json";
      opts.body = JSON.stringify(opts.body);
    }
    const res = await fetch(path, { ...opts, headers });
    if (res.status === 401) {
      const detail = await res.json().then((j) => (j && j.detail) || null).catch(() => null);
      const isLogin = String(path).includes("/api/auth/login");
      if (!isLogin) {
        setToken("");
        setUser(null);
        if (window.location.pathname !== "/login.html") {
          window.location.replace("/login.html");
        }
      }
      const err = new Error(detail || "unauthorized");
      err.status = 401;
      err.detail = detail;
      throw err;
    }
    if (res.status === 403) {
      const detail = await res.json().then((j) => j && j.detail).catch(() => null);
      if (detail === "must_change_password") {
        window.location.replace("/login.html?flow=change-password");
      }
      const err = new Error(detail || "forbidden");
      err.status = 403;
      err.detail = detail;
      throw err;
    }
    if (!res.ok) {
      const err = new Error((await res.json().catch(() => null))?.detail || `HTTP ${res.status}`);
      err.status = res.status;
      throw err;
    }
    if (res.status === 204) return null;
    const ct = res.headers.get("content-type") || "";
    if (ct.includes("application/json")) return res.json();
    return res.text();
  }

  async function login(username, password) {
    const data = await api("/api/auth/login", {
      method: "POST",
      body: { username, password },
    });
    setToken(data.token);
    setUser({ username: data.username, role: data.role, must_change_password: data.must_change_password });
    return data;
  }

  async function changePassword(currentPassword, newPassword) {
    const data = await api("/api/auth/change-password", {
      method: "POST",
      body: { current_password: currentPassword, new_password: newPassword },
    });
    if (user) user.must_change_password = false;
    setUser(user);
    return data;
  }

  function logout() {
    setToken("");
    setUser(null);
    window.location.replace("/login.html");
  }

  /** Authenticated file download (blob) with a friendly filename. */
  async function download(path, filename) {
    const headers = {};
    if (token) headers["Authorization"] = `Bearer ${token}`;
    const res = await fetch(path, { headers });
    if (!res.ok) {
      const err = new Error(`HTTP ${res.status}`);
      err.status = res.status;
      throw err;
    }
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename || "download";
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 4000);
    return true;
  }

  /** Resolves true when a valid session exists, else redirects to login. */
  const ready = (async () => {
    if (!token) {
      window.location.replace("/login.html");
      return false;
    }
    try {
      const me = await api("/api/auth/me");
      setUser(me);
      return true;
    } catch (err) {
      if (err.status === 401) return false;
      throw err;
    }
  })();

  return { api, login, logout, changePassword, download, ready, getUser, get token() { return token; } };
})();
