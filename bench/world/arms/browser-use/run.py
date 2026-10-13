#!/usr/bin/env python3
# Browser Use arm: its own agent loop, ChatAnthropic, throwaway Chrome profile.
import asyncio
import os
import shutil
import sys
import tempfile
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'lib'))
from cli import CHROME, anthropic_key, apply_telemetry, fake_answer, llm_kwargs, map_model, parse_args, task_prompt
from result import write_events
from usage import usage_from_browser_use


def fake_run(args):
    write_events(
        args.out,
        fake_answer(args),
        duration_ms=0,
        calls=[{'name': args.arm, 'input': {'fake': True}, 'result': 'dry-run'}],
        usage={},
        cost=0,
    )


def call(obj, name):
    value = getattr(obj, name, None)
    if callable(value):
        value = value()
    return value


def history_outcome(history):
    done = call(history, 'is_done')
    if done is None:
        done = call(history, 'done')
    if done:
        value = call(history, 'final_result')
        if value:
            return str(value), False
        extracted = call(history, 'extracted_content')
        if extracted:
            if isinstance(extracted, list):
                extracted = '\n'.join(str(x) for x in extracted if x)
            if extracted:
                return str(extracted), False
        return 'Browser Use finished with no answer', True
    errors = call(history, 'errors')
    if isinstance(errors, (list, tuple)):
        errors = [e for e in errors if e]
    if errors:
        return (errors[0] if isinstance(errors, (list, tuple)) else str(errors)), True
    return 'Browser Use did not call done', True


async def spend(agent, model):
    if agent is None:
        return {}, 0
    getter = getattr(getattr(agent, 'token_cost_service', None), 'get_usage_summary', None)
    if not callable(getter):
        return {}, 0
    try:
        summary = getter()
        if hasattr(summary, '__await__'):
            summary = await summary
    except Exception:
        return {}, 0
    return usage_from_browser_use(type('H', (), {'usage': summary})(), model)


def history_calls(history, arm):
    steps = call(history, 'history') or call(history, 'model_actions') or []
    n = call(history, 'number_of_steps')
    if not steps and n:
        steps = range(int(n))
    calls = [{'name': arm, 'input': {'step': i}, 'result': str(step)[:300]} for i, step in enumerate(steps or [0])]
    return calls or [{'name': arm, 'input': {'step': 0}, 'result': ''}]


async def maybe_await(value):
    if hasattr(value, '__await__'):
        return await value
    return value


async def kill_browser(browser):
    try:
        await maybe_await(browser.kill())
    except Exception:
        close = getattr(browser, 'close', None) or getattr(browser, 'stop', None)
        if callable(close):
            try:
                await maybe_await(close())
            except Exception:
                pass


async def live_async(args):
    apply_telemetry()
    if not os.path.isfile(CHROME):
        raise SystemExit('Chrome not found at %s' % CHROME)
    key = anthropic_key()
    from browser_use import Agent, Browser, ChatAnthropic
    model = map_model(args.model)
    llm = ChatAnthropic(**llm_kwargs(ChatAnthropic, args.model, args.effort, key))
    profile = tempfile.mkdtemp(prefix='sleight-browser-use-')
    os.environ.pop('ANTHROPIC_API_KEY', None)
    started = time.time()
    browser = Browser(executable_path=CHROME, user_data_dir=profile)

    async def on_timeout():
        await asyncio.sleep(args.budget_seconds)
        await kill_browser(browser)

    killer = asyncio.create_task(on_timeout())
    agent = None
    try:
        agent = Agent(task=task_prompt(args), llm=llm, browser=browser)
        try:
            history = await asyncio.wait_for(maybe_await(agent.run()), timeout=args.budget_seconds)
        except asyncio.TimeoutError:
            usage, cost = await spend(agent, model)
            write_events(
                args.out, 'budget-seconds exceeded',
                duration_ms=int((time.time() - started) * 1000),
                calls=[{'name': args.arm, 'input': {}, 'result': 'timeout'}],
                usage=usage, cost=cost, is_error=True,
            )
            return
        usage, cost = usage_from_browser_use(history, model)
        answer, is_error = history_outcome(history)
        write_events(
            args.out,
            answer,
            duration_ms=int((time.time() - started) * 1000),
            calls=history_calls(history, args.arm),
            usage=usage,
            cost=cost,
            is_error=is_error,
        )
    except BaseException as error:
        if isinstance(error, (KeyboardInterrupt, SystemExit)):
            raise
        usage, cost = await spend(agent, model)
        write_events(
            args.out, str(error),
            duration_ms=int((time.time() - started) * 1000),
            calls=[{'name': args.arm, 'input': {}, 'result': str(error)}],
            usage=usage, cost=cost, is_error=True,
        )
    finally:
        killer.cancel()
        try:
            await killer
        except (asyncio.CancelledError, Exception):
            pass
        await kill_browser(browser)
        shutil.rmtree(profile, ignore_errors=True)


def fail(args, error):
    write_events(
        args.out, str(error), duration_ms=0,
        calls=[{'name': args.arm, 'input': {}, 'result': str(error)}],
        usage={}, cost=0, is_error=True,
    )


def main(argv=None):
    args = parse_args(argv)
    if args.fake:
        fake_run(args)
        return
    try:
        asyncio.run(live_async(args))
    except BaseException as error:
        if isinstance(error, KeyboardInterrupt):
            raise
        fail(args, error)
        return 1
    return 0


if __name__ == '__main__':
    sys.exit(main() or 0)
