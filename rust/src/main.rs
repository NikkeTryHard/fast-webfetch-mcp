use std::env;
use std::time::Duration;

use anyhow::{anyhow, Context, Result};
use futures_util::StreamExt;
use regex::Regex;
use reqwest::header::{ACCEPT, ACCEPT_LANGUAGE, CACHE_CONTROL, USER_AGENT};
use reqwest::{Client, Url};
use serde::{Deserialize, Serialize};

const DEFAULT_MAX_LENGTH: usize = 100_000;
const DEFAULT_MAX_BYTES: usize = 4 * 1024 * 1024;
const UA: &str = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";
const FIRECRAWL_API_URL: &str = "http://localhost:3002";

#[derive(Debug, Clone)]
struct AppConfig {
    max_length: usize,
    max_bytes: usize,
    timeout_ms: u64,
}

#[derive(Debug, Deserialize)]
struct Input {
    url: String,
    #[serde(default)]
    max_length: Option<usize>,
    #[serde(default)]
    max_bytes: Option<usize>,
}

#[derive(Debug, Serialize)]
struct Output {
    url: String,
    status: u16,
    title: String,
    markdown: String,
    truncated: bool,
    bytes_read: usize,
    backend: String,
}

#[derive(Debug, Deserialize)]
struct FirecrawlResponse {
    success: bool,
    data: Option<FirecrawlData>,
}

#[derive(Debug, Deserialize)]
struct FirecrawlData {
    markdown: Option<String>,
    metadata: Option<FirecrawlMetadata>,
}

#[derive(Debug, Deserialize)]
struct FirecrawlMetadata {
    title: Option<String>,
    #[serde(rename = "sourceURL")]
    source_url: Option<String>,
    #[serde(rename = "statusCode")]
    status_code: Option<u16>,
}

#[derive(Debug, Serialize)]
struct FirecrawlRequest<'a> {
    url: &'a str,
    formats: Vec<&'a str>,
    #[serde(rename = "onlyMainContent")]
    only_main_content: bool,
    timeout: u64,
}

fn middle_truncate(text: &str, max_length: usize) -> (String, bool) {
    if text.chars().count() <= max_length {
        return (text.to_owned(), false);
    }

    let reserve = 100usize.min(max_length.saturating_sub(1));
    let half = max_length.saturating_sub(reserve) / 2;
    let start: String = text.chars().take(half).collect();
    let end: String = text
        .chars()
        .rev()
        .take(half)
        .collect::<String>()
        .chars()
        .rev()
        .collect();
    let dropped = text.chars().count().saturating_sub(max_length);
    (
        format!("{start}\n\n... [truncated {dropped} characters] ...\n\n{end}"),
        true,
    )
}

async fn fetch_html_bounded(client: &Client, url: &str, max_bytes: usize) -> Result<(String, Url, u16, usize)> {
    let response = client
        .get(url)
        .header(USER_AGENT, UA)
        .header(ACCEPT, "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8")
        .header(ACCEPT_LANGUAGE, "en-US,en;q=0.9")
        .header(CACHE_CONTROL, "no-cache")
        .send()
        .await
        .with_context(|| format!("failed to fetch URL: {url}"))?;

    let status = response.status().as_u16();
    if status >= 400 {
        return Err(anyhow!("HTTP {status} while fetching {url}"));
    }

    if let Some(content_len) = response.content_length() {
        if content_len as usize > max_bytes {
            return Err(anyhow!(
                "response too large by content-length: {content_len} > {max_bytes} bytes"
            ));
        }
    }

    let final_url = response.url().clone();
    let mut stream = response.bytes_stream();
    let mut buf = Vec::with_capacity(64 * 1024);
    let mut total = 0usize;

    while let Some(next) = stream.next().await {
        let chunk = next.context("failed while streaming response body")?;
        total += chunk.len();
        if total > max_bytes {
            return Err(anyhow!("response exceeded max_bytes limit: {total} > {max_bytes}"));
        }
        buf.extend_from_slice(&chunk);
    }

    let html = String::from_utf8_lossy(&buf).into_owned();
    Ok((html, final_url, status, total))
}

fn html_to_markdown(html: &str) -> String {
    html2md::parse_html(html)
}

fn extract_title(html: &str) -> String {
    let re = Regex::new(r"(?is)<title[^>]*>(.*?)</title>").expect("valid title regex");
    re.captures(html)
        .and_then(|caps| caps.get(1).map(|m| m.as_str().trim().to_owned()))
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| "Fetched Content".to_owned())
}

async fn scrape_firecrawl(
    client: &Client,
    url: &str,
    timeout_ms: u64,
    max_bytes: usize,
) -> Result<Option<(String, String, String, u16, usize)>> {
    let req = FirecrawlRequest {
        url,
        formats: vec!["markdown"],
        only_main_content: true,
        timeout: timeout_ms,
    };

    let response = match client
        .post(format!("{FIRECRAWL_API_URL}/v1/scrape"))
        .header("Content-Type", "application/json")
        .json(&req)
        .send()
        .await
    {
        Ok(resp) => resp,
        Err(_) => return Ok(None),
    };

    if !response.status().is_success() {
        return Ok(None);
    }

    let bytes = response
        .bytes()
        .await
        .context("failed reading firecrawl response")?;

    if bytes.len() > max_bytes {
        return Err(anyhow!(
            "firecrawl response exceeded max_bytes limit: {} > {}",
            bytes.len(),
            max_bytes
        ));
    }

    let parsed: FirecrawlResponse = serde_json::from_slice(&bytes).context("invalid firecrawl JSON")?;
    if !parsed.success {
        return Ok(None);
    }

    let data = match parsed.data {
        Some(d) => d,
        None => return Ok(None),
    };

    let markdown = match data.markdown {
        Some(m) if !m.is_empty() => m,
        _ => return Ok(None),
    };

    let title = data
        .metadata
        .as_ref()
        .and_then(|m| m.title.clone())
        .filter(|t| !t.trim().is_empty())
        .unwrap_or_else(|| "Fetched Content".to_owned());

    let status = data
        .metadata
        .as_ref()
        .and_then(|m| m.status_code)
        .unwrap_or(200);

    let final_url = data
        .metadata
        .as_ref()
        .and_then(|m| m.source_url.clone())
        .unwrap_or_else(|| url.to_owned());

    Ok(Some((markdown, title, format!("firecrawl:{final_url}"), status, bytes.len())))
}

#[tokio::main]
async fn main() -> Result<()> {
    let input_raw = env::var("FAST_WEBFETCH_INPUT")
        .context("FAST_WEBFETCH_INPUT env var required (JSON: {\"url\":\"...\"})")?;

    let input: Input = serde_json::from_str(&input_raw).context("invalid FAST_WEBFETCH_INPUT JSON")?;

    let config = AppConfig {
        max_length: input.max_length.unwrap_or(DEFAULT_MAX_LENGTH),
        max_bytes: input.max_bytes.unwrap_or(DEFAULT_MAX_BYTES),
        timeout_ms: 30_000,
    };

    let client = Client::builder()
        .connect_timeout(Duration::from_millis(config.timeout_ms))
        .read_timeout(Duration::from_millis(config.timeout_ms))
        .timeout(Duration::from_millis(config.timeout_ms))
        .pool_max_idle_per_host(4)
        .pool_idle_timeout(Duration::from_secs(15))
        .build()
        .context("failed to build reqwest client")?;

    let (title, markdown, final_url, status, bytes_read, backend) =
        match scrape_firecrawl(&client, &input.url, config.timeout_ms, config.max_bytes).await? {
            Some((firecrawl_markdown, firecrawl_title, firecrawl_final, firecrawl_status, read)) => {
                let cleaned_final = firecrawl_final.trim_start_matches("firecrawl:").to_owned();
                (
                    firecrawl_title,
                    firecrawl_markdown,
                    cleaned_final,
                    firecrawl_status,
                    read,
                    "firecrawl".to_owned(),
                )
            }
            None => {
                let (html, final_url, status, bytes_read) =
                    fetch_html_bounded(&client, &input.url, config.max_bytes).await?;
                let title = extract_title(&html);
                let markdown = html_to_markdown(&html);
                (title, markdown, final_url.to_string(), status, bytes_read, "fallback".to_owned())
            }
        };

    let (markdown, truncated) = middle_truncate(&markdown, config.max_length);

    let output = Output {
        url: final_url,
        status,
        title,
        markdown,
        truncated,
        bytes_read,
        backend,
    };

    let json = serde_json::to_string_pretty(&output).context("failed to serialize output")?;
    println!("{json}");
    Ok(())
}
