import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';

/**
 * An answered agent question must become a durable record.
 *
 * Reported symptom: ericli asked a multiple-choice question, the user picked an
 * option, and the card stayed at the bottom of the panel in collapsed mode with
 * every option still listed. The wire was fine — the traffic log shows
 * `_acp/ask_question` answered with selectedOptionIds ["o2"] 20s after the ask —
 * so all three faults were in the panel:
 *
 *  1. renderAgentQuestion touched chatHistory and saveState ZERO times, so the
 *     card was DOM-only. Eight sites do messagesEl.innerHTML = '', any of which
 *     destroyed it, and the decision never reached the transcript, a resume, or
 *     memory capture — despite askQuestion's comment promising it did.
 *  2. It was appended to messagesEl, which in turn/collapsed mode sits AFTER the
 *     whole turn container, so it stayed below replies produced later.
 *  3. settle() only dimmed the card and disabled the buttons.
 *
 * Pending cards stay pinned at the bottom by design — a question the user cannot
 * see is a hung agent. This covers what happens once it is answered.
 *
 * recordDecision is extracted from the real webview source and driven against an
 * injected DOM, so the assertions are about shipped behaviour.
 */
suite('agent question: the decision is recorded', () => {
  const src = fs.readFileSync(path.resolve(__dirname, '../../src/ui/ChatWebviewProvider.ts'), 'utf8');

  function extract(signature: string): string {
    const start = src.indexOf(signature);
    assert.ok(start >= 0, `${signature} not found`);
    let depth = 0;
    for (let i = start; i < src.length; i++) {
      if (src[i] === '{') {
        depth++;
      } else if (src[i] === '}' && --depth === 0) {
        return src.slice(start, i + 1);
      }
    }
    throw new Error(`unbalanced braces extracting ${signature}`);
  }

  /** Collapse template-literal escapes the way the emitted webview script sees them. */
  function decode(s: string): string {
    return s.replace(/\\\\/g, '\\');
  }

  interface FakeEl {
    className: string;
    textContent: string;
    innerHTML: string;
    children: FakeEl[];
    attrs: Record<string, string>;
    classes: string[];
    classList: { add: (...c: string[]) => void; contains: (c: string) => boolean };
    appendChild: (c: FakeEl) => void;
    setAttribute: (k: string, v: string) => void;
    querySelectorAll: () => FakeEl[];
  }

  function el(): FakeEl {
    const node: FakeEl = {
      className: '',
      textContent: '',
      innerHTML: 'buttons live here',
      children: [],
      attrs: {},
      classes: [],
      classList: {
        add: (...c: string[]) => {
          node.classes.push(...c);
        },
        contains: (c: string) => node.classes.indexOf(c) >= 0,
      },
      appendChild: (c: FakeEl) => {
        node.children.push(c);
      },
      setAttribute: (k: string, v: string) => {
        node.attrs[k] = v;
      },
      querySelectorAll: () => [],
    };
    return node;
  }

  type Ctx = {
    chatHistory: Array<{ kind: string; role: string; text: string }>;
    saves: number;
    wrap: FakeEl;
    foldBody: FakeEl | null;
  };

  function run(
    questions: unknown[],
    outcome: unknown,
    opts: { withTurn?: boolean } = {},
  ): Ctx {
    const wrap = el();
    const foldBody = opts.withTurn === false ? null : el();
    const ctx: Ctx = { chatHistory: [], saves: 0, wrap, foldBody };
    const body = decode(extract('function recordDecision(outcome) {'));
    const harness = `
      var chatHistory = ctx.chatHistory;
      function saveState() { ctx.saves++; }
      var wrap = ctx.wrap;
      var questions = qs;
      var messagesEl = { };
      var currentTurnEl = ctx.foldBody ? { parentNode: messagesEl, appendChild: function (c) { ctx.wrap = c; } } : null;
      function getTurnFoldBody() { return ctx.foldBody; }
      var document = { createElement: function () { return mk(); } };
      ${body}
      recordDecision(outcome);
    `;
    new Function('ctx', 'qs', 'outcome', 'mk', harness)(ctx, questions, outcome, el);
    return ctx;
  }

  const oneQuestion = [
    {
      id: 'q1',
      prompt: 'How should I fix the config?',
      options: [
        { id: 'o0', label: 'Disable eli-mcp and eridoc' },
        { id: 'o1', label: 'Remove the two entries entirely' },
        { id: 'o2', label: "Something else — I'll explain" },
      ],
    },
  ];
  const answered = (ids: string[]) => ({
    outcome: 'answered',
    answers: [{ questionId: 'q1', selectedOptionIds: ids }],
  });

  test('the exchange is pushed to chatHistory and saved', () => {
    const ctx = run(oneQuestion, answered(['o2']));
    assert.strictEqual(ctx.chatHistory.length, 1, 'exactly one transcript item');
    assert.strictEqual(ctx.chatHistory[0].kind, 'message');
    assert.strictEqual(ctx.chatHistory[0].role, 'system');
    assert.strictEqual(ctx.saves, 1, 'saveState must run or it dies with the webview');
  });

  test('the record carries the question AND the chosen label, not the option id', () => {
    const text = run(oneQuestion, answered(['o2'])).chatHistory[0].text;
    assert.ok(text.includes('How should I fix the config?'), 'question missing');
    assert.ok(text.includes("Something else — I'll explain"), 'chosen label missing');
    assert.ok(!text.includes('o2'), 'the raw option id is not a human record');
  });

  test('only the chosen option is recorded — not the whole menu', () => {
    // The reported symptom was every option staying on screen.
    const text = run(oneQuestion, answered(['o0'])).chatHistory[0].text;
    assert.ok(text.includes('Disable eli-mcp and eridoc'));
    assert.ok(!text.includes('Remove the two entries entirely'), 'unchosen option leaked in');
    assert.ok(!text.includes("Something else"), 'unchosen option leaked in');
  });

  test('multi-select records every chosen label', () => {
    const text = run(oneQuestion, answered(['o0', 'o2'])).chatHistory[0].text;
    assert.ok(text.includes('Disable eli-mcp and eridoc'));
    assert.ok(text.includes("Something else — I'll explain"));
  });

  test('cancelled and agent-decides outcomes are distinguishable', () => {
    assert.ok(run(oneQuestion, { outcome: 'cancelled' }).chatHistory[0].text.includes('(cancelled)'));
    assert.ok(
      run(oneQuestion, { outcome: 'skipped' }).chatHistory[0].text.includes('(left to the agent)'),
      'a skipped question must still be recorded, not left blank',
    );
  });

  test('an id with no matching option is still recorded rather than dropped', () => {
    const text = run(oneQuestion, answered(['made-up-id'])).chatHistory[0].text;
    assert.ok(text.includes('made-up-id'), 'an unknown answer must not vanish');
  });

  test('free text supplied instead of an option id is recorded', () => {
    const text = run(oneQuestion, {
      outcome: 'answered',
      answers: [{ questionId: 'q1', selectedOptionIds: [], text: 'do it the other way' }],
    }).chatHistory[0].text;
    assert.ok(text.includes('do it the other way'));
  });

  test('several questions each get their own line', () => {
    const qs = [
      { id: 'q1', prompt: 'First?', options: [{ id: 'a', label: 'yes' }] },
      { id: 'q2', prompt: 'Second?', options: [{ id: 'b', label: 'no' }] },
    ];
    const text = run(qs, {
      outcome: 'answered',
      answers: [
        { questionId: 'q1', selectedOptionIds: ['a'] },
        { questionId: 'q2', selectedOptionIds: ['b'] },
      ],
    }).chatHistory[0].text;
    assert.ok(text.includes('First?') && text.includes('yes'));
    assert.ok(text.includes('Second?') && text.includes('no'));
    assert.ok(text.indexOf('First?') < text.indexOf('Second?'), 'question order preserved');
  });

  test('the option buttons are cleared and the card is stamped for fold ordering', () => {
    const ctx = run(oneQuestion, answered(['o0']), { withTurn: false });
    assert.strictEqual(ctx.wrap.innerHTML, '', 'the option list must be torn down');
    assert.strictEqual(
      ctx.wrap.attrs['data-history-index'],
      '0',
      'the stamp must match the pushed index so historyOrder places it chronologically',
    );
    assert.ok(ctx.wrap.classes.indexOf('agent-question-record') >= 0, 'record class missing');
  });

  test('the answered card is filed into the turn instead of left below it', () => {
    // This is the "left in the bottom in collapsed mode" half of the report.
    const ctx = run(oneQuestion, answered(['o0']), { withTurn: true });
    assert.ok(ctx.foldBody, 'harness should supply a fold body');
    assert.strictEqual(ctx.foldBody!.children.length, 1, 'the card must move into the turn fold');
  });

  suite('ordering guarantees in source', () => {
    const settle = extract('function settle(outcome) {');

    test('the answer is posted to the host BEFORE the card is re-rendered', () => {
      const post = settle.indexOf("type: 'answerQuestion'");
      const record = settle.indexOf('recordDecision(');
      assert.ok(post > 0 && record > 0, 'both steps must exist');
      assert.ok(post < record, 'a rendering slip must never delay unblocking the agent');
    });

    test('a throw while recording cannot swallow the answer', () => {
      assert.ok(/try\s*\{[\s\S]*recordDecision\(outcome\);[\s\S]*\}\s*catch/.test(settle), 'not guarded');
    });

    test('double settle is still impossible', () => {
      assert.ok(settle.includes('if (answered) return;'), 'the re-entry guard was lost');
    });
  });
});
