const localServices = [
  ['PostgreSQL', 'System-of-record foundation'],
  ['Redis × 2', 'Queue and ephemeral workloads are isolated'],
  ['Mailpit', 'Local-only captured SMTP'],
  ['Jaeger', 'Local trace inspection'],
];

export default function HomePage() {
  return (
    <main className="shell">
      <p className="eyebrow">PULSE//FIELD · local commerce platform</p>
      <h1>Architecture and delivery foundation</h1>
      <p className="lede">
        The application shell, versioned API, local infrastructure, security controls, and
        module contracts are ready. Commerce workflows begin in their scheduled phases.
      </p>
      <section aria-labelledby="local-profile-heading" className="panel">
        <div>
          <p className="eyebrow">Development profile</p>
          <h2 id="local-profile-heading">Zero-cost, local-only</h2>
        </div>
        <p>
          No deployment, live Stripe processing, SaaS credential, or real-recipient email is
          required. Startup rejects live Stripe keys, remote SMTP, and billable adapters.
        </p>
      </section>
      <section aria-labelledby="services-heading">
        <h2 id="services-heading">Local topology</h2>
        <ul className="service-list">
          {localServices.map(([name, description]) => (
            <li key={name}>
              <strong>{name}</strong>
              <span>{description}</span>
            </li>
          ))}
        </ul>
      </section>
      <p className="hint">
        API health: <code>http://localhost:4000/api/v1/health</code> · API contract:{' '}
        <code>http://localhost:4000/api/docs</code>
      </p>
    </main>
  );
}
