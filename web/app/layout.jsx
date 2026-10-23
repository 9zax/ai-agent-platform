import './globals.css'
import AuthGate from '@/components/auth-gate'

export const metadata = {
  title: 'AI Agent Platform',
  description: 'AI Agent Orchestration Dashboard',
}

export default function RootLayout({ children }) {
  return (
    <html lang="en">
      <head>
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800&display=swap" rel="stylesheet" />
      </head>
      <body>
        <AuthGate>{children}</AuthGate>
      </body>
    </html>
  )
}
