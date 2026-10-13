# FowlBrowser runner result: stream-json events.jsonl with a `result` event the grader reads
# (answer, duration_ms, num_turns, usage tokens, total_cost_usd). Same fields as claude -p.
from __future__ import print_function

import json
import os
import sys
import time


def usage_dict(usage=None):
    usage = usage or {}
    return {
        'input_tokens': int(usage.get('input_tokens') or 0),
        'cache_creation_input_tokens': int(usage.get('cache_creation_input_tokens') or 0),
        'cache_read_input_tokens': int(usage.get('cache_read_input_tokens') or 0),
        'output_tokens': int(usage.get('output_tokens') or 0),
    }


def write_events(out_dir, answer, duration_ms, calls, usage=None, cost=0, is_error=False, model=None):
    os.makedirs(out_dir, exist_ok=True)
    started = int(time.time() * 1000)
    events = []
    for i, call in enumerate(calls):
        cid = 'c%d' % i
        t = started + i
        events.append({
            't': t,
            'type': 'assistant',
            'message': {
                'role': 'assistant',
                'content': [{
                    'type': 'tool_use',
                    'id': cid,
                    'name': call.get('name') or 'agent',
                    'input': call.get('input') or {},
                }],
            },
        })
        events.append({
            't': t + 1,
            'type': 'user',
            'message': {
                'role': 'user',
                'content': [{
                    'type': 'tool_result',
                    'tool_use_id': cid,
                    'content': call.get('result') or '',
                    'is_error': bool(call.get('is_error')),
                }],
            },
        })
    events.append({
        't': started + max(len(calls), 1),
        'type': 'result',
        'subtype': 'error' if is_error else 'success',
        'is_error': bool(is_error),
        'result': answer,
        'duration_ms': int(duration_ms),
        'num_turns': len(calls),
        'usage': usage_dict(usage),
        'total_cost_usd': float(cost or 0),
        **({'model': model} if model else {}),
    })
    for event in events:
        sys.stdout.write(json.dumps(event) + '\n')
    sys.stdout.flush()
    return os.path.join(out_dir, 'events.jsonl')
