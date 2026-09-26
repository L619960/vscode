// 联网搜索：DuckDuckGo HTML 版（无需 API Key），正则提取结果与摘要

/** DuckDuckGo 结果链接是 /l/?uddg= 跳转，解码出真实 URL */
function decodeDdgUrl(href: string): string {
  const m = /[?&]uddg=([^&]+)/.exec(href)
  if (m) {
    try { return decodeURIComponent(m[1]) } catch { /* 保留原链接 */ }
  }
  return href
}

/**
 * 联网搜索，返回「标题: 链接\n摘要」格式的多条结果文本
 * 网络失败时抛出带中文说明的错误，由调用方转为工具错误结果
 */
export async function webSearch(query: string): Promise<string> {
  const url = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`
  let html: string
  try {
    const response = await fetch(url, {
      headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' },
    })
    if (!response.ok) throw new Error(`HTTP ${response.status}`)
    html = await response.text()
  } catch (e) {
    throw new Error(`网络请求失败: ${(e as Error).message}`)
  }

  // 提取结果标题与链接（最多 5 条）
  const results: string[] = []
  const regex = /<a[^>]*class="result__a"[^>]*href="([^"]*)"[^>]*>([^<]*)<\/a>/g
  let match: RegExpExecArray | null
  while ((match = regex.exec(html)) && results.length < 5) {
    results.push(`${match[2]}: ${decodeDdgUrl(match[1])}`)
  }

  // 提取结果摘要（最多 5 条，去掉内部标签）
  const snippetRegex = /<a[^>]*class="result__snippet"[^>]*>([\s\S]*?)<\/a>/g
  const snippets: string[] = []
  while ((match = snippetRegex.exec(html)) && snippets.length < 5) {
    snippets.push(match[1].replace(/<[^>]*>/g, '').trim())
  }

  return results.map((r, i) => `${r}\n${snippets[i] || ''}`).join('\n\n')
}
