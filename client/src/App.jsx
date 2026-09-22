import { useEffect, useState } from "react";
import "./App.css";

const emptyForm = { name: "", url: "", alertEmail: "" };
const REFRESH_MS = 30_000;

async function requestJson(path, options = {}) {
  const response = await fetch(path, options);
  const text = await response.text();
  let data = null;

  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      data = { message: "The server returned an invalid response" };
    }
  }

  if (!response.ok) {
    throw new Error(data?.message || `Request failed (${response.status})`);
  }

  return data;
}

function statusFor(project) {
  if (project.status === "paused") return { label: "Paused", className: "paused" };
  if (project.isUp === null || project.isUp === undefined) {
    return { label: "Not checked", className: "unknown" };
  }
  return project.isUp
    ? { label: "Operational", className: "up" }
    : { label: "Down", className: "down" };
}

function formatDate(value) {
  if (!value) return "Never";
  return new Date(value).toLocaleString();
}

export default function App() {
  const [projects, setProjects] = useState([]);
  const [form, setForm] = useState(emptyForm);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [checkingId, setCheckingId] = useState("");
  const [updatingId, setUpdatingId] = useState("");
  const [deletingId, setDeletingId] = useState("");

  async function loadProjects({ showLoading = false } = {}) {
    if (showLoading) setLoading(true);
    try {
      const data = await requestJson("/api/projects");
      setProjects(Array.isArray(data) ? data : []);
      setError("");
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    let active = true;

    async function refresh() {
      try {
        const data = await requestJson("/api/projects");
        if (active) {
          setProjects(Array.isArray(data) ? data : []);
          setError("");
          setLoading(false);
        }
      } catch (err) {
        if (active) {
          setError(err.message);
          setLoading(false);
        }
      }
    }

    refresh();
    const interval = window.setInterval(refresh, REFRESH_MS);
    return () => {
      active = false;
      window.clearInterval(interval);
    };
  }, []);

  async function addProject(event) {
    event.preventDefault();
    setError("");
    setNotice("");
    setSubmitting(true);

    try {
      await requestJson("/api/projects", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(form),
      });
      setForm(emptyForm);
      setNotice("Site added.");
      await loadProjects();
    } catch (err) {
      setError(err.message);
    } finally {
      setSubmitting(false);
    }
  }

  async function checkNow(id) {
    setError("");
    setNotice("");
    setCheckingId(id);

    try {
      await requestJson(`/api/projects/${id}/check`, { method: "POST" });
      setNotice("Check completed.");
      await loadProjects();
    } catch (err) {
      setError(err.message);
    } finally {
      setCheckingId("");
    }
  }

  async function togglePaused(project) {
    const nextStatus = project.status === "paused" ? "active" : "paused";
    setError("");
    setNotice("");
    setUpdatingId(project._id);

    try {
      await requestJson(`/api/projects/${project._id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status: nextStatus }),
      });
      setNotice(nextStatus === "paused" ? "Site paused." : "Site resumed.");
      await loadProjects();
    } catch (err) {
      setError(err.message);
    } finally {
      setUpdatingId("");
    }
  }

  async function deleteProject(project) {
    if (!window.confirm(`Delete ${project.name}? Its check history will also be removed.`)) return;

    setError("");
    setNotice("");
    setDeletingId(project._id);

    try {
      await requestJson(`/api/projects/${project._id}`, { method: "DELETE" });
      setNotice("Site deleted.");
      await loadProjects();
    } catch (err) {
      setError(err.message);
    } finally {
      setDeletingId("");
    }
  }

  return (
    <main>
      <header className="hero">
        <div>
          <p className="eyebrow">UPTIME MONITORING</p>
          <h1>PingTower</h1>
          <p className="subtitle">Know when your sites are up, down, or quietly slowing down.</p>
        </div>
        <div className="refresh-note" aria-live="polite">
          <span className="pulse" aria-hidden="true" /> Refreshes every 30 seconds
        </div>
      </header>

      <section className="add-panel" aria-labelledby="add-heading">
        <div className="section-heading">
          <div>
            <p className="eyebrow">NEW MONITOR</p>
            <h2 id="add-heading">Add a site</h2>
          </div>
          <span className="secure-note">HTTP and HTTPS only</span>
        </div>
        <form onSubmit={addProject} className="add-form">
          <label>
            Site name
            <input
              value={form.name}
              onChange={(event) => setForm({ ...form, name: event.target.value })}
              placeholder="My website"
              autoComplete="organization"
              maxLength={120}
              required
            />
          </label>
          <label>
            URL
            <input
              type="url"
              value={form.url}
              onChange={(event) => setForm({ ...form, url: event.target.value })}
              placeholder="https://example.com"
              autoComplete="url"
              required
            />
          </label>
          <label>
            Alert email
            <input
              type="email"
              value={form.alertEmail}
              onChange={(event) => setForm({ ...form, alertEmail: event.target.value })}
              placeholder="you@example.com"
              autoComplete="email"
              required
            />
          </label>
          <button className="primary-button" type="submit" disabled={submitting}>
            {submitting ? "Adding…" : "Add site"}
          </button>
        </form>
      </section>

      <div className="messages" aria-live="polite" aria-atomic="true">
        {error && <p className="message error">{error}</p>}
        {notice && !error && <p className="message success">{notice}</p>}
      </div>

      <section aria-labelledby="sites-heading">
        <div className="list-heading">
          <div>
            <p className="eyebrow">YOUR MONITORS</p>
            <h2 id="sites-heading">Sites</h2>
          </div>
          <span className="site-count">{projects.length} {projects.length === 1 ? "site" : "sites"}</span>
        </div>

        {loading ? <p className="empty-state">Loading monitors…</p> : null}
        {!loading && !projects.length ? (
          <p className="empty-state">No monitors yet. Add your first site above.</p>
        ) : null}

        <div className="grid">
          {projects.map((project) => {
            const status = statusFor(project);
            const busy = checkingId === project._id || updatingId === project._id || deletingId === project._id;
            return (
              <article key={project._id} className="card">
                <div className="card-header">
                  <div className="title-row">
                    <span className={`dot ${status.className}`} aria-hidden="true" />
                    <h3>{project.name}</h3>
                  </div>
                  <span className={`status-badge ${status.className}`}>{status.label}</span>
                </div>

                <a className="site-url" href={project.url} target="_blank" rel="noreferrer">
                  {project.url}
                </a>
                <p className="last-checked">Last checked: {formatDate(project.lastCheckedAt)}</p>

                <div className="metrics">
                  <div>
                    <strong>{project.uptimePercent === null ? "—" : `${project.uptimePercent}%`}</strong>
                    <span>uptime</span>
                  </div>
                  <div>
                    <strong>{project.avgResponseTime === null ? "—" : `${project.avgResponseTime} ms`}</strong>
                    <span>avg response</span>
                  </div>
                  <div>
                    <strong>{project.checksInWindow ?? 0}</strong>
                    <span>recent checks</span>
                  </div>
                </div>

                <div
                  className="bar"
                  role="list"
                  aria-label={`${project.recentChecks.length} recent checks for ${project.name}`}
                >
                  {project.recentChecks.length ? (
                    project.recentChecks.map((check, index) => (
                      <span
                        key={check._id || `${check.checkedAt}-${index}`}
                        className={`seg ${check.isUp ? "up" : "down"}`}
                        role="listitem"
                        aria-label={`${check.isUp ? "Up" : "Down"} check at ${formatDate(check.checkedAt)}${
                          check.responseTime ? `, ${check.responseTime} milliseconds` : ""
                        }`}
                        title={`${check.isUp ? "Up" : "Down"} · ${check.responseTime} ms`}
                      />
                    ))
                  ) : (
                    <span className="no-checks">No checks yet</span>
                  )}
                </div>

                <div className="card-actions">
                  <button
                    className="primary-button compact"
                    type="button"
                    onClick={() => checkNow(project._id)}
                    disabled={busy || project.status === "paused"}
                  >
                    {checkingId === project._id ? "Checking…" : "Check now"}
                  </button>
                  <button
                    className="secondary-button compact"
                    type="button"
                    onClick={() => togglePaused(project)}
                    disabled={busy}
                  >
                    {updatingId === project._id
                      ? "Saving…"
                      : project.status === "paused"
                        ? "Resume"
                        : "Pause"}
                  </button>
                  <button
                    className="danger-button compact"
                    type="button"
                    onClick={() => deleteProject(project)}
                    disabled={busy}
                  >
                    {deletingId === project._id ? "Deleting…" : "Delete"}
                  </button>
                </div>
              </article>
            );
          })}
        </div>
      </section>
    </main>
  );
}
