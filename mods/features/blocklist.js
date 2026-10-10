import { configRead, configWrite } from '../config.js';

/**
 * YouTube-Blocky — channel & keyword blocklist filtering
 * Filters tiles before render via JSON.parse patch in adblock.js
 */

export function normalizeKeyword(kw) {
  return kw.trim().toLowerCase();
}

export function extractTitle(item) {
  if (!item) return null;
  if (item.tileRenderer?.metadata?.tileMetadataRenderer?.title?.simpleText) {
    return item.tileRenderer.metadata.tileMetadataRenderer.title.simpleText;
  }
  if (item.lockupViewModel?.metadata?.lockupMetadataViewModel?.title?.content) {
    return item.lockupViewModel.metadata.lockupMetadataViewModel.title.content;
  }
  // Fallback for compact renderers
  if (item.lockupViewModel?.metadata?.lockupMetadataViewModel?.title?.content) {
    return item.lockupViewModel.metadata.lockupMetadataViewModel.title.content;
  }
  return null;
}

export function extractChannel(item) {
  if (!item) return { id: null, name: null };

  let name = null;
  let id = null;

  // Name probes
  try {
    name =
      item.tileRenderer?.metadata?.tileMetadataRenderer?.lines?.[0]?.lineRenderer?.items?.[0]?.lineItemRenderer?.text?.runs?.[0]?.text ??
      item.tileRenderer?.metadata?.tileMetadataRenderer?.lines?.[0]?.lineRenderer?.items?.[0]?.lineItemRenderer?.text?.simpleText ??
      item.lockupViewModel?.metadata?.lockupMetadataViewModel?.metadata?.contentMetadataViewModel?.metadataRows?.[0]?.metadataParts?.[0]?.text?.content ??
      item.shortBylineText?.runs?.[0]?.text ??
      item.longBylineText?.runs?.[0]?.text ??
      item.lockupViewModel?.metadata?.lockupMetadataViewModel?.metadata?.contentMetadataViewModel?.metadataRows?.[1]?.metadataParts?.[0]?.text?.content ??
      null;

    // If name is object with runs
    if (name && typeof name === 'object' && name.runs) {
      name = name.runs[0]?.text ?? null;
    }
    if (name && typeof name === 'object' && name.simpleText) {
      name = name.simpleText;
    }
  } catch (_) {
    name = null;
  }

  try {
    id =
      item.tileRenderer?.onSelectCommand?.watchEndpoint?.browseId ??
      item.lockupViewModel?.rendererContext?.commandContext?.onTap?.innertubeCommand?.watchEndpoint?.ownerChannelId ??
      item.shortBylineText?.runs?.[0]?.navigationEndpoint?.browseEndpoint?.browseId ??
      item.longBylineText?.runs?.[0]?.navigationEndpoint?.browseEndpoint?.browseId ??
      null;

    // Probe menu browseId
    if (!id && item.tileRenderer?.menu?.menuRenderer?.items) {
      for (const mi of item.tileRenderer.menu.menuRenderer.items) {
        const bid = mi.menuNavigationItemRenderer?.navigationEndpoint?.browseEndpoint?.browseId
          ?? mi.menuServiceItemRenderer?.serviceEndpoint?.feedbackEndpoint?.feedbackToken; // not id, skip
        if (bid && bid.startsWith('UC')) { id = bid; break; }
      }
    }
    // lockupViewModel browseId in contentImage or elsewhere
    if (!id && item.lockupViewModel?.rendererContext?.commandContext?.onTap?.innertubeCommand?.browseEndpoint?.browseId) {
      id = item.lockupViewModel.rendererContext.commandContext.onTap.innertubeCommand.browseEndpoint.browseId;
    }
  } catch (_) {
    id = null;
  }

  return { id: id ?? null, name: name ?? null };
}

export function isBlocked(item) {
  const enableKeyword = configRead('enableKeywordBlocking');
  const enableChannel = configRead('enableChannelBlocking');

  if (!enableKeyword && !enableChannel) return false;

  // Keyword check — title substring case-insensitive
  if (enableKeyword) {
    const title = extractTitle(item);
    if (title) {
      const titleLower = title.toLowerCase();
      const keywords = configRead('blockedKeywords') || [];
      for (const kw of keywords) {
        if (kw && titleLower.includes(kw)) return true;
      }
    }
  }

  // Channel check — id exact, then name case-insensitive exact
  if (enableChannel) {
    const ch = extractChannel(item);
    const blockedChannels = configRead('blockedChannels') || [];
    if (!blockedChannels.length) return false;
    if (ch.id) {
      if (blockedChannels.some(c => c.id && c.id === ch.id)) return true;
    }
    if (ch.name) {
      const nameLower = ch.name.toLowerCase();
      if (blockedChannels.some(c => c.name && c.name.toLowerCase() === nameLower)) return true;
    }
  }

  return false;
}

export function filterItems(items) {
  if (!items || !items.length) return items;
  const kws = configRead('blockedKeywords') || [];
  const chs = configRead('blockedChannels') || [];
  const enableKeyword = configRead('enableKeywordBlocking');
  const enableChannel = configRead('enableChannelBlocking');

  if ((!kws.length && !chs.length) || (!enableKeyword && !enableChannel)) return items;

  return items.filter(item => {
    if (!item.tileRenderer && !item.lockupViewModel) return true;
    // Keep ad slots already handled elsewhere, but filter anyway
    return !isBlocked(item);
  });
}

// Helpers for settings UI / commands

export function addKeyword(raw) {
  const kw = normalizeKeyword(raw);
  if (!kw) return { ok: false, reason: 'empty' };
  const list = configRead('blockedKeywords') || [];
  if (list.includes(kw)) return { ok: false, reason: 'duplicate' };
  if (list.length >= 200) return { ok: false, reason: 'limit' };
  list.push(kw);
  configWrite('blockedKeywords', list);
  return { ok: true };
}

export function removeKeyword(raw) {
  const kw = normalizeKeyword(raw);
  const list = configRead('blockedKeywords') || [];
  const idx = list.indexOf(kw);
  if (idx === -1) return { ok: false, reason: 'not_found' };
  list.splice(idx, 1);
  configWrite('blockedKeywords', list);
  return { ok: true };
}

export function addChannel({ id, name }) {
  if (!name || !name.trim()) return { ok: false, reason: 'empty' };
  const trimmedName = name.trim();
  const list = configRead('blockedChannels') || [];
  if (id && list.some(c => c.id === id)) return { ok: false, reason: 'duplicate' };
  if (!id && list.some(c => !c.id && c.name.toLowerCase() === trimmedName.toLowerCase())) return { ok: false, reason: 'duplicate' };
  if (list.length >= 200) return { ok: false, reason: 'limit' };
  list.push({ id: id || null, name: trimmedName, addedAt: Date.now() });
  configWrite('blockedChannels', list);
  return { ok: true };
}

export function removeChannel({ id, name }) {
  const list = configRead('blockedChannels') || [];
  let idx = -1;
  if (id) idx = list.findIndex(c => c.id === id);
  else if (name) idx = list.findIndex(c => !c.id && c.name.toLowerCase() === name.toLowerCase());
  if (idx === -1) return { ok: false, reason: 'not_found' };
  list.splice(idx, 1);
  configWrite('blockedChannels', list);
  return { ok: true };
}

// Channel search via InnerTube — used by settings UI for autocomplete

function getKabukiClient() {
  for (const key in window._yttv) {
    const m = window._yttv[key];
    if (m && m.mappings) {
      const client = m.mappings.get('KabukiInnerTubeClient');
      if (client) return client;
    }
  }
  return null;
}

export function searchChannels(query) {
  return new Promise((resolve, reject) => {
    const client = getKabukiClient();
    if (!client) {
      reject(new Error('KabukiInnerTubeClient not found'));
      return;
    }
    const request = {
      path: '/youtubei/v1/search',
      payload: {
        query,
        params: 'EgIQAg%3D%3D' // channel filter
      }
    };
    client.fetch(request).subscribe(
      (response) => {
        try {
          const results = [];
          const contents = response?.contents?.sectionListRenderer?.contents
            ?? response?.contents?.tvBrowseRenderer?.content?.tvSurfaceContentRenderer?.content?.sectionListRenderer?.contents
            ?? [];

          for (const sec of contents) {
            const itemSection = sec.itemSectionRenderer?.contents ?? sec.shelfRenderer?.content?.horizontalListRenderer?.items ?? [];
            for (const entry of itemSection) {
              const cr = entry.channelRenderer ?? entry.compactChannelRenderer;
              if (!cr) continue;
              const id = cr.channelId ?? cr.navigationEndpoint?.browseEndpoint?.browseId ?? null;
              const name = cr.title?.simpleText ?? cr.displayName?.simpleText ?? cr.title?.runs?.[0]?.text ?? null;
              const thumb = cr.thumbnail?.thumbnails?.[0]?.url ?? cr.thumbnailViewModel?.image?.sources?.[0]?.url ?? null;
              if (id && name) results.push({ id, name, thumb });
              if (results.length >= 8) break;
            }
            if (results.length >= 8) break;
          }
          resolve(results);
        } catch (e) {
          reject(e);
        }
      },
      (err) => reject(err)
    );
  });
}
