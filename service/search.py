"""Bounded public title search: exact query, one base query, stable deduplication.

The upstream full-title search can return 40 unrelated matches before sequels,
even when its first result is exact. A main title before a colon (or a terminal
season marker) supplies one additional query. Punctuation folding is only for
matching and ranking; the user's original query reaches the upstream unchanged.
Search similarity is not an official season link; SeasonResolver still validates
candidate metadata, the shared album, content type and episode availability.
"""
from __future__ import annotations

import unicodedata

from seasons import parse_season_title


LIMIT = 40


def title_key(value):
    """Compare poster/search typography without changing words or season digits."""
    text = unicodedata.normalize('NFKC', str(value or '')).casefold()
    return ''.join(char for char in text
                   if not char.isspace() and unicodedata.category(char)[0] not in {'P', 'Z'})


def _main_title(value):
    text = unicodedata.normalize('NFKC', str(value or '')).strip()
    prefix, separator, suffix = text.partition(':')
    prefix = prefix.strip()
    return prefix if separator and suffix.strip() and 2 <= len(prefix) <= 80 else ''


def fallback_query(query, primary=()):
    """Choose at most one useful main/base title, including an exact-hit title."""
    parsed = parse_season_title(query)
    if not parsed.safe:
        return ''
    candidate = _main_title(parsed.base)
    if not candidate and parsed.explicit and 2 <= len(parsed.base) <= 80:
        candidate = parsed.base
    if not candidate:
        # Users can omit all punctuation that is present in the official title.
        query_base = title_key(parsed.base)
        for row in primary:
            title = parse_season_title(row.get('title'))
            if title.safe and title_key(title.base) == query_base:
                candidate = _main_title(title.base)
                if candidate:
                    break
    return candidate if candidate and title_key(candidate) != title_key(query) else ''


def _related(parsed, query_base):
    return parsed.safe and bool(query_base) and (title_key(parsed.base) == query_base
        or title_key(_main_title(parsed.base)) == query_base)


def rank_results(query, rows, *, limit=LIMIT):
    """Exact matches lead; matching title families keep their seasons together."""
    query_title = parse_season_title(query)
    query_key, query_base = title_key(query), title_key(query_title.base)
    unique, seen, groups = [], set(), {}
    for row in rows:
        sid = str(row.get('id') or '')
        if not sid or sid in seen:
            continue
        seen.add(sid)
        parsed = parse_season_title(row.get('title'))
        family = title_key(parsed.base)
        groups.setdefault(family, len(groups))
        related = _related(parsed, query_base)
        exact = title_key(row.get('title')) == query_key or (
            query_title.safe and query_title.explicit and related and parsed.index == query_title.index)
        position = len(unique)
        rank = ((0, position, 0) if exact else
                (1, groups[family], parsed.index) if related else (2, position, 0))
        unique.append((rank, row))
    unique.sort(key=lambda entry: entry[0])
    return [dict(row) for _, row in unique[:max(1, min(LIMIT, int(limit)))]]


def search_series(query, fetch):
    """Fetches are independently cached by the caller; failures remain retryable."""
    primary = fetch(query)
    fallback = fallback_query(query, primary)
    rows, warning = list(primary), ''
    if fallback:
        try:
            additional = fetch(fallback)
        except Exception:
            warning = '部分关联季暂时未能补齐，请稍后重试'
        else:
            query_base = title_key(parse_season_title(query).base)
            # The broader base query must not introduce unrelated recommendations.
            rows.extend(row for row in additional
                        if _related(parse_season_title(row.get('title')), query_base))
    return {'items': rank_results(query, rows), **({'warning': warning} if warning else {})}
