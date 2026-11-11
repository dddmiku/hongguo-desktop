"""Shared mobile drama-tab selection without SDK startup or credential access."""


def select_search_tab(response):
    """Read the mobile 剧集 tab (29), never the 综合 recommendations (11)."""
    tabs = response.get('search_tabs') if isinstance(response, dict) else None
    if not isinstance(tabs, list):
        raise RuntimeError('Search response is unavailable')
    if not tabs:
        return {'data': [], 'has_more': False, 'next_offset': 0}
    matches = [tab for tab in tabs if isinstance(tab, dict) and str(tab.get('tab_type')) == '29']
    if len(matches) != 1 or not isinstance(matches[0].get('data'), list):
        raise RuntimeError('Drama search response is unavailable')
    return matches[0]
