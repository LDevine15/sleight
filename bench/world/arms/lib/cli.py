import argparse
import inspect
import os
import subprocess
from pathlib import Path

CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
REPO = Path(__file__).resolve().parents[4]
API_AUTH = REPO / 'bench' / 'api-auth.mjs'
KEY_DIR = Path.home() / '.config' / 'sleight-bench'
TELEMETRY = {
    'ANONYMIZED_TELEMETRY': 'false',
    'BROWSER_USE_ANONYMIZED_TELEMETRY': 'false',
    'BROWSER_USE_CLOUD_SYNC': 'false',
    'DO_NOT_TRACK': '1',
}

# Same ids as bench/api-auth.mjs PRICES / Claude Code arms. Never 4.x.
MODELS = {
    'opus': 'claude-opus-5-5',
    'sonnet': 'claude-sonnet-5-5',
    'haiku': 'claude-haiku-5-5',
}
MAX_TOKENS = {'low': 16384, 'medium': 16384, 'high': 64000, 'max': 64000}


def parse_args(argv=None):
    p = argparse.ArgumentParser()
    p.add_argument('--prompt', required=True)
    p.add_argument('--out', required=True)
    p.add_argument('--model', default='opus')
    p.add_argument('--effort', default='medium')
    p.add_argument('--arm', required=True)
    p.add_argument('--result', default='')
    p.add_argument('--budget-seconds', type=int, default=600)
    p.add_argument('--fake', action='store_true')
    p.add_argument('--dry-run', action='store_true')
    args = p.parse_args(argv)
    args.fake = args.fake or args.dry_run
    return args


def apply_telemetry():
    for key, value in TELEMETRY.items():
        os.environ[key] = value


def fake_answer(args):
    return 'RESULT: fake model=%s effort=%s arm=%s' % (map_model(args.model), args.effort, args.arm)


def task_prompt(args):
    text = args.prompt
    if args.result:
        text += '\n\nEnd your answer with one line starting with RESULT: that states %s.' % args.result
    return text


def map_model(model):
    if model in MODELS:
        return MODELS[model]
    if model.startswith('claude-') and '-5-5' in model:
        return model
    if model.startswith('claude-'):
        raise SystemExit('model %s is not a Claude Code arm id; use claude-*-5-5' % model)
    return MODELS.get(model, model)


def anthropic_key():
    # Same checks as bench/api-auth.mjs readKey: regular file, owner, 0600, not a symlink, one sk-ant- key.
    script = (
        "import { pathToFileURL } from 'node:url';"
        "const { readKey } = await import(pathToFileURL(process.argv[1]).href);"
        "const k = readKey();"
        "if (!k) process.exit(2);"
        "process.stdout.write(k);"
    )
    ran = subprocess.run(['node', '--input-type=module', '-e', script, str(API_AUTH)],
                         capture_output=True, text=True)
    if ran.returncode != 0 or not ran.stdout:
        err = (ran.stderr or ran.stdout or 'missing anthropic API key').strip()
        raise SystemExit(err)
    return ran.stdout


def llm_kwargs(cls, model, effort, api_key):
    params = inspect.signature(cls.__init__).parameters
    kwargs = {'model': map_model(model), 'max_tokens': MAX_TOKENS.get(effort, 16384)}
    if 'api_key' in params:
        kwargs['api_key'] = api_key
    if 'thinking' in params:
        kwargs['thinking'] = {'type': 'adaptive'}
    if 'output_config' in params:
        kwargs['output_config'] = {'effort': effort}
    # max_tokens=64000 with the SDK default timeout demands streaming. 900 s is enough for high/max.
    if 'timeout' in params:
        kwargs['timeout'] = 900
    return kwargs
