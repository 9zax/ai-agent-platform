const { test, expect } = require('@playwright/test')
const { sessionToken } = require('./lib/auth')

const API = 'http://localhost:8000'

// Project Docs — the per-project document space (PO/BA/SA), written in-app or
// uploaded as files. Also exercises the orchestrator's ?raw=1 download path.
test.describe('Project Docs', () => {
  test('docs tab: create markdown doc, edit, upload file, download, delete', async ({ page }) => {
    // Clean slate
    const existing = await page.evaluate(async ([url, token]) => {
      const res = await fetch(`${url}/projects`, { headers: { 'x-session-token': token } })
      return (await res.json()).filter(p => p.name.startsWith('E2E Docs'))
    }, [API, sessionToken()])
    for (const p of existing) {
      await page.evaluate(async ([url, token, id]) => { await fetch(`${url}/projects/${id}`, { method: 'DELETE', headers: { 'x-session-token': token } }) }, [API, sessionToken(), p.id])
    }

    // Seed a project via API
    const project = await page.evaluate(async ([url, token]) => {
      const res = await fetch(`${url}/projects`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-session-token': token },
        body: JSON.stringify({ name: 'E2E Docs Project', description: 'doc space test' }),
      })
      return await res.json()
    }, [API, sessionToken()])
    expect(project.id).toBeTruthy()

    try {
      await page.goto(`/projects/${project.id}`)
      await expect(page.getByTestId('tab-mission')).toBeVisible()

      // Open the Docs tab (lazy-mounted on first click)
      await page.getByRole('tab', { name: 'Docs' }).click()
      await expect(page.getByRole('tab', { name: 'Docs' })).toHaveAttribute('aria-selected', 'true')
      await expect(page.getByTestId('project-docs')).toBeVisible()
      await expect(page.getByTestId('docs-empty')).toBeVisible()

      // Create a markdown doc in the PO folder
      await page.getByTestId('doc-new').click()
      await page.getByTestId('doc-title-input').fill('E2E Vision Doc')
      await page.getByTestId('doc-folder-pick').filter({ hasText: /^PO$/ }).click()
      await page.getByTestId('md-editor').fill('# Vision\n\n- ผู้ใช้จ่ายเงินได้\n- **จริง**')
      await page.getByTestId('md-toggle').click()
      await expect(page.getByTestId('md-preview')).toContainText('ผู้ใช้จ่ายเงินได้')
      await page.getByTestId('doc-save').click()
      const row = page.getByTestId('doc-row').filter({ hasText: 'E2E Vision Doc' })
      await expect(row).toBeVisible({ timeout: 10000 })
      await expect(page.getByTestId('doc-view')).toContainText('Vision')

      // API sanity: folder persisted, markdown inline
      const docs1 = await page.evaluate(async ([url, token, pid]) => {
        const res = await fetch(`${url}/projects/${pid}/docs`, { headers: { 'x-session-token': token } })
        return await res.json()
      }, [API, sessionToken(), project.id])
      const created = docs1.find(d => d.title === 'E2E Vision Doc')
      expect(created.folder).toBe('PO')
      expect(created.content_md).toContain('Vision')
      expect(created.file).toBeNull()

      // Edit — viewer reflects the update
      await row.getByTestId('doc-edit').click()
      await page.getByTestId('md-editor').fill('# Vision v2\n\nอัปเดตแล้ว')
      await page.getByTestId('doc-save').click()
      await expect(page.getByTestId('doc-view')).toContainText('Vision v2', { timeout: 10000 })

      // Upload a small PDF
      await page.getByTestId('doc-upload-input').setInputFiles({
        name: 'e2e-spec.pdf',
        mimeType: 'application/pdf',
        buffer: Buffer.from('%PDF-1.4\ne2e upload'),
      })
      const uploadRow = page.getByTestId('doc-row').filter({ hasText: 'e2e-spec' })
      await expect(uploadRow).toBeVisible({ timeout: 10000 })

      const docs2 = await page.evaluate(async ([url, token, pid]) => {
        const res = await fetch(`${url}/projects/${pid}/docs`, { headers: { 'x-session-token': token } })
        return await res.json()
      }, [API, sessionToken(), project.id])
      const uploaded = docs2.find(d => d.file?.name === 'e2e-spec.pdf')
      expect(uploaded).toBeTruthy()
      expect(uploaded.content_md).toBe('')

      // Raw download: attachment header carries the original filename
      const disposition = await page.evaluate(async ([url, token, pid, did]) => {
        const res = await fetch(`${url}/projects/${pid}/docs/${did}?raw=1`, { headers: { 'x-session-token': token } })
        return { status: res.status, disposition: res.headers.get('content-disposition'), type: res.headers.get('content-type') }
      }, [API, sessionToken(), project.id, uploaded.id])
      expect(disposition.status).toBe(200)
      expect(disposition.disposition).toContain('e2e-spec.pdf')
      expect(disposition.type).toBe('application/pdf')

      // Delete the uploaded doc — its row disappears
      await uploadRow.getByTestId('doc-delete').click()
      await expect(page.getByTestId('doc-row').filter({ hasText: 'e2e-spec' })).toHaveCount(0, { timeout: 10000 })
    } finally {
      // Cleanup — deleting the project cascades its docs
      await page.evaluate(async ([url, token, id]) => {
        await fetch(`${url}/projects/${id}`, { method: 'DELETE', headers: { 'x-session-token': token } })
      }, [API, sessionToken(), project.id])
    }
    const left = await page.evaluate(async ([url, token]) => {
      const res = await fetch(`${url}/projects`, { headers: { 'x-session-token': token } })
      return (await res.json()).some(p => p.name === 'E2E Docs Project')
    }, [API, sessionToken()])
    expect(left).toBe(false)
  })
})
