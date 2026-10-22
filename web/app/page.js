export default function Home() {
  return (
    <div style={{ fontFamily: 'system-ui', padding: '40px', background: '#0f172a', color: '#e2e8f0', minHeight: '100vh' }}>
      <h1>AI Agent Platform</h1>
      <p style={{ color: '#94a3b8' }}>MVP Dashboard</p>
      <div style={{ marginTop: '32px' }}>
        <p>Web: http://localhost:3000</p>
        <p>API: http://localhost:8000/docs</p>
        <p>noVNC: http://localhost:6080</p>
      </div>
    </div>
  )
}
