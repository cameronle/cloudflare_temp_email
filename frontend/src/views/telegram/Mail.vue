<script setup>
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useRoute } from 'vue-router'

import { useGlobalState } from '../../store'
import { api } from '../../api'
import { processItem } from '../../utils/email-parser'
import { utcToLocalDate } from '../../utils'

const { telegramApp, loading, useUTCDate, isDark } = useGlobalState()
const route = useRoute()

const curMail = ref({})
const iframeRef = ref(null)
const frameObserver = ref(null)

const escapeHtml = (value) => String(value || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;')

const emailFrameStyles = computed(() => {
    const dark = isDark.value
    const colors = dark
        ? { bg: '#181b21', text: '#e5e7eb', link: '#93c5fd', border: '#343b48' }
        : { bg: '#ffffff', text: '#1f2937', link: '#2563eb', border: '#dbe3ee' }
    return `
<style>
  :root { color-scheme: ${dark ? 'dark' : 'light'}; }
  html, body {
    margin: 0 !important;
    padding: 0 !important;
    min-width: 0 !important;
    width: 100% !important;
    background: ${colors.bg} !important;
    color: ${colors.text} !important;
    font: 14px/1.7 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif !important;
    overflow-wrap: anywhere !important;
    word-break: break-word !important;
  }
  body { padding: 18px clamp(14px, 4vw, 30px) !important; box-sizing: border-box !important; }
  img, video, svg, canvas { max-width: 100% !important; height: auto !important; }
  table { max-width: 100% !important; width: auto !important; height: auto !important; }
  pre, code { white-space: pre-wrap !important; overflow-wrap: anywhere !important; word-break: break-word !important; }
  a { color: ${colors.link} !important; overflow-wrap: anywhere !important; }
  blockquote { margin-left: 0 !important; margin-right: 0 !important; padding-left: 12px !important; border-left: 3px solid ${colors.border} !important; }
</style>
`
})

const frameSource = computed(() => {
    const message = curMail.value?.message || ''
    if (!message) return ''
    const hasHtml = /<([a-z][\w-]*)(?:\s[^>]*)?>/i.test(message)
    const body = hasHtml ? message : `<pre>${escapeHtml(message)}</pre>`
    if (/<\/head>/i.test(body)) {
        return body.replace(/<\/head>/i, `${emailFrameStyles.value}</head>`)
    }
    return `${emailFrameStyles.value}${body}`
})

const fitFrame = () => {
    const frame = iframeRef.value
    if (!frame) return
    try {
        const doc = frame.contentDocument
        const body = doc?.body
        const html = doc?.documentElement
        const height = Math.max(body?.scrollHeight || 0, html?.scrollHeight || 0, 360)
        frame.style.height = `${Math.min(height + 4, 16000)}px`
    } catch {
        frame.style.height = 'min(72vh, 720px)'
    }
}

const handleFrameLoad = () => {
    frameObserver.value?.disconnect()
    frameObserver.value = null
    fitFrame()
    const doc = iframeRef.value?.contentDocument
    if (doc?.documentElement && typeof ResizeObserver !== 'undefined') {
        frameObserver.value = new ResizeObserver(fitFrame)
        frameObserver.value.observe(doc.documentElement)
    }
    window.setTimeout(fitFrame, 120)
    window.setTimeout(fitFrame, 800)
}

const fetchMailData = async () => {
    try {
        const res = await api.fetch('/telegram/get_mail', {
            method: 'POST',
            body: JSON.stringify({
                initData: telegramApp.value.initData,
                mailId: route.query.mail_id
            })
        })
        loading.value = true
        return await processItem(res)
    } catch (error) {
        console.error(error)
        return {}
    } finally {
        loading.value = false
    }
}

watch(telegramApp, async () => {
    if (telegramApp.value.initData) {
        curMail.value = await fetchMailData()
        await nextTick()
        fitFrame()
    }
})

onMounted(async () => {
    curMail.value = await fetchMailData()
    await nextTick()
    fitFrame()
})

onBeforeUnmount(() => frameObserver.value?.disconnect())
</script>

<template>
    <div class="telegram-mail-page" :class="{ 'is-dark': isDark }">
        <main v-if="curMail.message" class="mail-shell">
            <header class="mail-header">
                <div class="mail-eyebrow">Telegram Mini App</div>
                <h1>{{ curMail.subject || 'No subject' }}</h1>
                <div class="mail-meta">
                    <div class="meta-item">
                        <span class="meta-label">From</span>
                        <span class="meta-value">{{ curMail.source || '—' }}</span>
                    </div>
                    <div class="meta-item">
                        <span class="meta-label">To</span>
                        <span class="meta-value">{{ curMail.address || '—' }}</span>
                    </div>
                    <div class="meta-item">
                        <span class="meta-label">Date</span>
                        <span class="meta-value">{{ utcToLocalDate(curMail.created_at, useUTCDate) }}</span>
                    </div>
                    <div class="meta-item">
                        <span class="meta-label">ID</span>
                        <span class="meta-value">#{{ curMail.id }}</span>
                    </div>
                </div>
            </header>

            <section class="mail-content-card" aria-label="Email content">
                <div class="content-heading">
                    <span class="content-title">Message</span>
                    <span class="content-hint">Full email content</span>
                </div>
                <iframe
                    ref="iframeRef"
                    class="mail-frame"
                    :srcdoc="frameSource"
                    title="Email content"
                    sandbox=""
                    referrerpolicy="no-referrer"
                    scrolling="no"
                    @load="handleFrameLoad"
                />
            </section>

            <footer class="mail-footer">版权所有 © 2023-2026 Dream Hunter</footer>
        </main>

        <div v-else class="mail-empty">Loading email…</div>
    </div>
</template>

<style scoped>
.telegram-mail-page {
    min-height: 100dvh;
    box-sizing: border-box;
    padding: max(14px, env(safe-area-inset-top)) max(12px, env(safe-area-inset-right)) max(20px, env(safe-area-inset-bottom)) max(12px, env(safe-area-inset-left));
    background: #f3f6fb;
    color: #1f2937;
}

.mail-shell {
    width: min(100%, 900px);
    margin: 0 auto;
}

.mail-header,
.mail-content-card {
    border: 1px solid #e5eaf2;
    border-radius: 18px;
    background: #ffffff;
    box-shadow: 0 8px 30px rgba(31, 41, 55, 0.07);
}

.mail-header {
    padding: clamp(16px, 4vw, 26px);
}

.mail-eyebrow {
    color: #64748b;
    font-size: 11px;
    font-weight: 700;
    letter-spacing: 0.1em;
    line-height: 1.2;
    text-transform: uppercase;
}

h1 {
    margin: 9px 0 18px;
    color: #111827;
    font-size: clamp(20px, 5vw, 30px);
    font-weight: 750;
    line-height: 1.25;
    overflow-wrap: anywhere;
    word-break: break-word;
}

.mail-meta {
    display: grid;
    grid-template-columns: repeat(2, minmax(0, 1fr));
    gap: 9px;
}

.meta-item {
    min-width: 0;
    padding: 10px 12px;
    border: 1px solid #edf0f5;
    border-radius: 12px;
    background: #f8fafc;
}

.meta-label,
.meta-value {
    display: block;
    min-width: 0;
    overflow-wrap: anywhere;
    word-break: break-word;
}

.meta-label {
    margin-bottom: 3px;
    color: #64748b;
    font-size: 11px;
    font-weight: 700;
    letter-spacing: 0.04em;
    text-transform: uppercase;
}

.meta-value {
    color: #334155;
    font-size: 13px;
    line-height: 1.45;
}

.mail-content-card {
    margin-top: 14px;
    overflow: hidden;
}

.content-heading {
    display: flex;
    align-items: baseline;
    justify-content: space-between;
    gap: 12px;
    padding: 14px 16px;
    border-bottom: 1px solid #edf0f5;
}

.content-title {
    color: #1f2937;
    font-size: 14px;
    font-weight: 750;
}

.content-hint {
    color: #94a3b8;
    font-size: 11px;
}

.mail-frame {
    display: block;
    width: 100%;
    min-height: 360px;
    height: 420px;
    border: 0;
    background: #ffffff;
}

.mail-footer {
    padding: 18px 8px 2px;
    color: #94a3b8;
    font-size: 11px;
    text-align: center;
}

.mail-empty {
    display: grid;
    min-height: 70dvh;
    place-items: center;
    color: #64748b;
    font-size: 14px;
}

.telegram-mail-page.is-dark {
    background: #0f1116;
    color: #e5e7eb;
}

.telegram-mail-page.is-dark .mail-header,
.telegram-mail-page.is-dark .mail-content-card {
    border-color: #2b313c;
    background: #181b21;
    box-shadow: 0 10px 32px rgba(0, 0, 0, 0.24);
}

.telegram-mail-page.is-dark .mail-eyebrow,
.telegram-mail-page.is-dark .meta-label,
.telegram-mail-page.is-dark .content-hint,
.telegram-mail-page.is-dark .mail-footer {
    color: #9ca3af;
}

.telegram-mail-page.is-dark h1,
.telegram-mail-page.is-dark .content-title {
    color: #f8fafc;
}

.telegram-mail-page.is-dark .meta-item {
    border-color: #303744;
    background: #20252d;
}

.telegram-mail-page.is-dark .meta-value {
    color: #d1d5db;
}

.telegram-mail-page.is-dark .content-heading {
    border-bottom-color: #2b313c;
}

.telegram-mail-page.is-dark .mail-frame {
    background: #181b21;
}

@media (max-width: 560px) {
    .telegram-mail-page {
        padding-top: max(10px, env(safe-area-inset-top));
    }

    .mail-header {
        border-radius: 15px;
        padding: 16px;
    }

    .mail-meta {
        grid-template-columns: 1fr;
        gap: 8px;
    }

    .meta-item {
        padding: 9px 11px;
    }

    .mail-content-card {
        border-radius: 15px;
    }

    .content-heading {
        align-items: flex-start;
        flex-direction: column;
        gap: 3px;
        padding: 13px 14px;
    }

    .mail-frame {
        min-height: 420px;
    }
}
</style>
