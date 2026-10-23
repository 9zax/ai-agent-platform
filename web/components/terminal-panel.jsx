'use client'

import { useEffect, useRef, useState } from 'react'
import { Terminal as XTerm } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import '@xterm/xterm/css/xterm.css'
import { getToken } from '@/lib/auth'
import { Button } from '@/components/ui/button'
import { RotateCw } from 'lucide-react'

const API = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:8000'

// Real interactive shell: xterm.js ⇄ WebSocket ⇄ orchestrator ⇄ host PTY
// attached to the agent's tmux session (grouped — several viewers coexist).
// Binary frames are terminal bytes, text frames are control messages (resize).
export default function TerminalPanel({ containerId, tall = false }) {
  const hostRef = useRef(null)
  const [state, setState] = useState('connecting') // connecting | connected | closed
  const [session, setSession] = useState(0) // bump to reconnect

  useEffect(() => {
    const host = hostRef.current
    if (!host) return

    const term = new XTerm({
      cursorBlink: true,
      fontSize: 12,
      fontFamily: '"SF Mono", Menlo, Monaco, "Courier New", monospace',
      scrollback: 5000,
      theme: {
        background: '#0d1420',
        foreground: '#e2e8f0',
        cursor: '#a78bfa',
        selectionBackground: '#3b4261',
      },
    })
    const fit = new FitAddon()
    term.loadAddon(fit)
    term.open(host)
    try { fit.fit() } catch { /* container may still be laying out */ }
    term.focus()

    const proto = API.replace(/^http/, 'ws')
    const token = encodeURIComponent(getToken())
    const url = `${proto}/containers/${encodeURIComponent(containerId)}/terminal/ws?token=${token}&cols=${term.cols}&rows=${term.rows}`
    term.writeln('\x1b[90mConnecting to the agent session…\x1b[0m')

    const encoder = new TextEncoder()
    const decoder = new TextDecoder()
    let ws
    try {
      ws = new WebSocket(url)
    } catch {
      setState('closed')
      term.writeln('\r\n\x1b[31mfailed to open socket\x1b[0m')
      return
    }
    ws.binaryType = 'arraybuffer'

    ws.onopen = () => {
      setState('connected')
      term.reset()
    }
    ws.onmessage = ev => {
      if (typeof ev.data === 'string') return // control channel — server only sends terminal bytes
      term.write(decoder.decode(new Uint8Array(ev.data)))
    }
    ws.onclose = () => {
      setState('closed')
      term.writeln('\r\n\x1b[90m— session ended —\x1b[0m')
    }
    term.onData(data => {
      if (ws.readyState === WebSocket.OPEN) ws.send(encoder.encode(data))
    })

    const ro = new ResizeObserver(() => {
      try { fit.fit() } catch { /* ignore mid-teardown */ }
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ resize: { cols: term.cols, rows: term.rows } }))
      }
    })
    ro.observe(host)

    return () => {
      ro.disconnect()
      ws.onclose = null
      ws.close()
      term.dispose()
    }
  }, [containerId, session])

  return (
    <div className="overflow-hidden rounded-[10px] border border-border/80" data-testid="terminal-panel">
      <div className="flex items-center gap-2 bg-[#0a0f18] px-3 py-1.5 text-[11px]">
        <span className={`h-1.5 w-1.5 rounded-full ${state === 'connected' ? 'bg-emerald-400' : state === 'connecting' ? 'animate-pulse bg-amber-400' : 'bg-red-400'}`} />
        <span className="font-semibold text-muted-foreground/80">
          {state === 'connected' ? `bash — interactive session` : state === 'connecting' ? 'connecting…' : 'disconnected'}
        </span>
        {state === 'closed' && (
          <Button variant="outline" size="sm" className="ml-auto h-6 px-2 text-[11px]" onClick={() => setSession(s => s + 1)} data-testid="terminal-reconnect">
            <RotateCw className="h-3 w-3" /> Reconnect
          </Button>
        )}
      </div>
      <div ref={hostRef} className={`${tall ? 'h-[520px]' : 'h-[340px]'} w-full bg-[#0d1420] p-2`} data-testid="terminal" onClick={() => hostRef.current?.querySelector('textarea')?.focus()} />
    </div>
  )
}
