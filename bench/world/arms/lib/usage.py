# Browser Use 0.13.11 UsageSummary: total_prompt_tokens already includes cache reads.
# Cost comes from bench/api-auth.mjs PRICES, never LiteLLM / total_cost.
import re
from pathlib import Path

REPO = Path(__file__).resolve().parents[4]
API_AUTH = REPO / 'bench' / 'api-auth.mjs'


def usage_fields(usage):
    if usage is None:
        return {
            'input_tokens': 0,
            'cache_creation_input_tokens': 0,
            'cache_read_input_tokens': 0,
            'output_tokens': 0,
        }
    get = usage.get if isinstance(usage, dict) else lambda k, d=None: getattr(usage, k, d)
    prompt = int(get('total_prompt_tokens') or 0)
    cached = int(get('total_prompt_cached_tokens') or 0)
    return {
        'input_tokens': max(prompt - cached, 0),
        'cache_creation_input_tokens': int(get('total_prompt_cache_creation_tokens') or 0),
        'cache_read_input_tokens': cached,
        'output_tokens': int(get('total_completion_tokens') or 0),
    }


def load_prices(path=None):
    text = Path(path or API_AUTH).read_text()
    prices = {}
    for match in re.finditer(
            r"'claude-(haiku|sonnet|opus)-5-5': \{ input: ([0-9.]+), output: ([0-9.]+), cacheRead: ([0-9.]+) \}",
            text):
        prices['claude-%s-5-5' % match.group(1)] = {
            'input': float(match.group(2)),
            'output': float(match.group(3)),
            'cacheRead': float(match.group(4)),
        }
    if len(prices) != 3:
        raise RuntimeError('PRICES missing from bench/api-auth.mjs')
    return prices


def cost_from_prices(model, usage, prices=None):
    prices = prices or load_prices()
    price = prices.get(model)
    if not price:
        return 0.0
    uncached = int(usage.get('input_tokens') or 0)
    cached = int(usage.get('cache_read_input_tokens') or 0)
    created = int(usage.get('cache_creation_input_tokens') or 0)
    output = int(usage.get('output_tokens') or 0)
    total = (uncached * price['input'] + output * price['output']
             + cached * price['cacheRead'] + created * price['input'] * 2) / 1e6
    return round(total * 1e7) / 1e7


def usage_from_browser_use(history, model='claude-opus-5-5', prices=None):
    usage = getattr(history, 'usage', None)
    if callable(usage):
        usage = usage()
    fields = usage_fields(usage)
    return fields, cost_from_prices(model, fields, prices)
