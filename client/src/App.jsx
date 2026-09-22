import { useEffect, useState } from "react";
import "./App.css";

const emptyForm = { name: "", url: "", alertEmail: "" };

export default function App() {
  const [projects, setProjects] = useState([]);
  const [form, setForm] = useState(emptyForm);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);

  async function loadProjects() {
    const response = await fetch("/api/projects");
    const data = await response.json();
    setProjects(data);
    setLoading(false);
  }

  useEffect(() => {
    loadProjects().catch((err) => setError(err.message));
  }, []);

  async function addProject(event) {
    event.preventDefault();
    setError("");

    const response = await fetch("/api/projects", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(form),
    });
    const data = await response.json();

    if (!response.ok) {
      setError(data.message || "Could not add project");
      return;
    }

    setForm(emptyForm);
    await loadProjects();
  }

  async function checkNow(id) {
    setError("");
    const response = await fetch(`/api/projects/${id}/check`, { method: "POST" });
    const data = await response.json();
    if (!response.ok) {
      setError(data.message || "Check failed");
      return;
    }
    await loadProjects();
  }

  return (
    <main>
      <header>
        <h1>PingTower</h1>
        <p>Uptime checks for sites you own.</p>
      </header>

      <form onSubmit={addProject}>
        <input
          placeholder="Name"
          value={form.name}
          onChange={(e) => setForm({ ...form, name: e.target.value })}
          required
        />
        <input
          placeholder="https://example.com"
          value={form.url}
          onChange={(e) => setForm({ ...form, url: e.target.value })}
          required
        />
        <input
          type="email"
          placeholder="alert@email.com"
          value={form.alertEmail}
          onChange={(e) => setForm({ ...form, alertEmail: e.target.value })}
          required
        />
        <button>Add site</button>
      </form>

      {error && <p className="error">{error}</p>}
      {loading ? <p>Loading…</p> : null}

      <section className="grid">
        {projects.map((project) => (
          <article key={project._id} className="card">
            <div className="row">
              <span className={project.isUp ? "dot up" : "dot down"} />
              <h2>{project.name}</h2>
            </div>
            <a href={project.url}>{project.url}</a>
            <p>
              {project.uptimePercent === null
                ? "No checks yet"
                : `${project.uptimePercent}% up · ${project.avgResponseTime ?? "—"} ms`}
            </p>
            <div className="bar" aria-hidden="true">
              {project.recentChecks.map((check) => (
                <span
                  key={check._id}
                  className={check.isUp ? "seg up" : "seg down"}
                  title={`${check.isUp ? "Up" : "Down"} · ${check.responseTime} ms`}
                />
              ))}
            </div>
            <button onClick={() => checkNow(project._id)}>Check now</button>
          </article>
        ))}
      </section>
    </main>
  );
}
