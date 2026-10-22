# Connectors

Per-container connectors — สไตล์เดียวกับ Grok connectors: ทุก agent container
ต่อบริการด้วย credential ของตัวเอง platform เป็นแค่ตัวกลาง (broker) —
ไม่เก็บ token ใน Store/DB/logs สถานะ connected ทั้งหมด derive จากการ probe
ตัว container จริงทุกครั้ง ไม่ใช่แค่ claim

## GitHub

ต่อได้ 2 วิธี (เลือกใน Connect dialog บนหน้า Container):

| วิธี | ใช้เมื่อ |
|---|---|
| Browser (device flow) | login ปกติผ่าน browser — เปิด github.com/login/device แล้วกรอก code (หรือกดเปิด browser ในเดสก์ท็อปของ container นั้น) |
| Personal access token | วาง PAT (classic/fine-grained, scope `repo`) — เหมาะกับงาน automate/CI |

สองวิธีจบที่ path เดียวกัน: ยืนยัน token กับ GitHub API ก่อน แล้ว inject
ผ่าน exec ENV เป็น `gh auth login --with-token` + `gh auth setup-git`
git push/pull ใช้ได้ทันที พร้อม git identity ที่ดึงจาก profile ของ account นั้น

## Figma

Auth ด้วย personal access token วิธีเดียว (Figma ไม่มี device flow):
สร้าง token ที่ Settings → Security → Personal access tokens แล้ววางใน dialog

token ถูกเก็บใน container ที่ `~/.config/figma/token` พร้อม export
`FIGMA_TOKEN` ใน shell profiles — agent ในเครื่องนั้นเรียก Figma REST API
(อ่าน design file, ดึง component, export รูป) ได้โดยตรง

## Security model

- token ไม่ผ่าน Store/DB/logs ของ platform — ข้ามไป container ผ่าน exec ENV
  ตอน inject เท่านั้น และไม่โผล่ใน `ps`/shell history
- credential ทั้งหมดอยู่ใน container ของตัวเอง — disconnect คือลบทิ้งจากในนั้น
- state (`connected` + `@login`) มาจากการ probe ใน container เป็นระยะ
  (cache สั้นๆ กัน spam exec) ไม่ใช่สถานะที่จำไว้
