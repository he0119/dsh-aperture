/**
 * 请求转换：宿主的消息词汇 → pi-ai 的 `Context`。
 *
 * 端到端那一份只走一条「一轮问答」的直路；这里钉的是它到不了的那些分支——system 提示的两种
 * 来路、历史中段的系统提示、工具结果认领工具名、图片的字节与预算、以及重放元数据「读得出来」与
 * 「读不出来」两种情形。读不出来时的降级尤其重要：升级过的部署里，同一条路由早先是
 * `llm-pi-ai` 在服务，它的重放信封在本适配器眼里是不可读的——那时必须降级成 provider 中立的内容，
 * 而不是把一条没有签名的思考块发给 Anthropic（那会被拒）。
 *
 * @module dsh-aperture/test/context
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  createAssistantMessage,
  createToolResultMessage,
  createUserMessage,
  type ContentBlock,
  type GenerateOptions,
} from '@deepseek-ai/dsh-llm';
import type { AttachmentStore, ImageAttachmentRef, RequestImageAttachment } from '@deepseek-ai/dsh-attachment';
import type {
  AssistantMessage as PiAssistantMessage,
  ImageContent,
  TextContent,
  ToolResultMessage as PiToolResultMessage,
  UserMessage as PiUserMessage,
} from '@earendil-works/pi-ai';
import { toPiContext } from '../src/adapter/context.ts';
import { REPLAY_KIND, REPLAY_VERSION } from '../src/adapter/replay.ts';

/** 一条用户消息。 */
function user(text: string): ReturnType<typeof createUserMessage> {
  return createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } });
}

/** 一条带重放元数据的助手消息。 */
function assistant(
  content: readonly ContentBlock[],
  replayState?: unknown,
): ReturnType<typeof createAssistantMessage> {
  return createAssistantMessage({
    content,
    source: {
      provider: 'aperture',
      model: 'm',
      ...(replayState === undefined ? {} : { replayState }),
    },
  });
}

/** 一个请求。 */
function request(overrides: Partial<GenerateOptions> = {}): GenerateOptions {
  return { provider: 'aperture', model: 'm', messages: [user('hi')], ...overrides };
}

/** 取出一条 user 消息的文本。 */
function textOf(message: PiUserMessage | PiToolResultMessage): string {
  if (typeof message.content === 'string') return message.content;
  return message.content
    .filter((block): block is TextContent => block.type === 'text')
    .map((block) => block.text)
    .join('');
}

/** 一份附件服务替身：按声明的字节数回答，字节内容由调用方给定。 */
function attachments(bytes = 3, size = 8): AttachmentStore {
  return {
    readImageRequest: (ref: ImageAttachmentRef): Promise<RequestImageAttachment> =>
      Promise.resolve({
        // 品牌化的字段在夹具里只能用一次断言：它们标记的是「来源可信」，
        // 而这里正是要伪造一个来源可信的附件。
        variantId: `${ref.attachmentId}@1` as RequestImageAttachment['variantId'],
        attachment: ref,
        data: new Uint8Array(size),
        mediaType: 'image/png',
        bytes,
        width: ref.width,
        height: ref.height,
        depth: 'uchar',
        space: 'srgb',
        hasAlpha: false,
      }),
  } as unknown as AttachmentStore;
}

/** 一张图片附件引用。 */
function imageRef(attachmentId: string, overrides: Partial<ImageAttachmentRef> = {}): ImageAttachmentRef {
  return {
    attachmentId: attachmentId as ImageAttachmentRef['attachmentId'],
    mediaType: 'image/png',
    bytes: 3,
    width: 2,
    height: 2,
    ...overrides,
  };
}

describe('system 提示的两种来路', () => {
  it('`system` 字段独占了提示位', async () => {
    const context = await toPiContext(request({ system: '你是助手', messages: [user('hi')] }));
    assert.equal(context.systemPrompt, '你是助手');
    assert.equal(context.messages.length, 1);
  });

  it('历史首位的 system 消息被取成提示，且不再作为一条消息出现', async () => {
    const context = await toPiContext(request({
      messages: [
        { role: 'system', content: [{ type: 'text', text: '你是助手' }], source: { kind: 'system-prompt' } },
        user('hi'),
      ] as never,
    }));
    assert.equal(context.systemPrompt, '你是助手');
    assert.deepEqual(context.messages.map((message) => message.role), ['user']);
  });

  it('历史中段的系统提示降级成一条 user 消息，而不是丢掉', async () => {
    const context = await toPiContext(request({
      system: '首位的提示',
      messages: [{ role: 'system', content: [{ type: 'text', text: '中途补充' }] }, user('hi')] as never,
    }));
    assert.equal(context.systemPrompt, '首位的提示');
    assert.equal(context.messages.length, 2);
    assert.equal(textOf(context.messages[0] as PiUserMessage), '中途补充');
  });

  it('空的首位 system 消息不产生 systemPrompt，而是被丢掉', async () => {
    const context = await toPiContext(request({
      messages: [{ role: 'system', content: [], source: { kind: 'system-prompt' } }, user('hi')] as never,
    }));
    assert.equal(context.systemPrompt, undefined);
    assert.equal(context.messages.length, 1);
  });
});

describe('用户与工具结果的形状', () => {
  it('只有文本时给字符串，空块不参与拼接', async () => {
    const context = await toPiContext(request({
      messages: [createUserMessage({
        content: [{ type: 'text', text: '' }, { type: 'text', text: 'po' }, { type: 'text', text: 'ng' }],
        source: { kind: 'user' },
      })],
    }));
    assert.equal(textOf(context.messages[0] as PiUserMessage), 'pong');
  });

  it('工具结果认领同名工具，认不出时给一个中性名字', async () => {
    const context = await toPiContext(request({
      messages: [
        assistant([{ type: 'tool-call', id: 'call-1' as never, name: 'read', arguments: '{}' }]),
        createToolResultMessage({ callId: 'call-1' as never, content: [{ type: 'text', text: 'file body' }], isError: false }),
        createToolResultMessage({ callId: 'call-2' as never, content: [{ type: 'text', text: 'nope' }], isError: true }),
      ],
    }));

    const first = context.messages[1] as PiToolResultMessage;
    assert.equal(first.role, 'toolResult');
    assert.equal(first.toolName, 'read');
    assert.equal(first.isError, false);
    assert.equal(textOf(first), 'file body');

    const second = context.messages[2] as PiToolResultMessage;
    assert.equal(second.toolName, 'unknown', '认不出的调用只回显中性名字，绝不编造一个');
    assert.equal(second.isError, true);
  });

  it('工具没有输出时也要有话说：空内容变成一句占位', async () => {
    const context = await toPiContext(request({
      messages: [createToolResultMessage({ callId: 'call-1' as never, content: [], isError: false })],
    }));
    assert.deepEqual((context.messages[0] as PiToolResultMessage).content, [
      { type: 'text', text: '(no output)' },
    ]);
  });

  it('工具声明原样交给 pi-ai，空清单整个省略', async () => {
    const tool = { name: 'read', description: '读一个文件', parameters: { type: 'object' } };
    const withTool = await toPiContext(request({ tools: [tool] }));
    assert.deepEqual(withTool.tools, [tool]);
    assert.equal('tools' in (await toPiContext(request({ tools: [] }))), false);
  });
});

describe('图片', () => {
  it('把附件版本转成 base64，并配上宿主的句柄文本', async () => {
    const context = await toPiContext(
      request({
        messages: [createUserMessage({
          content: [{ type: 'text', text: '看看这个' }, { type: 'image', attachment: imageRef('img-1') }],
          source: { kind: 'user' },
        })],
      }),
      { attachments: attachments() },
    );

    // 顺序就是块在历史里的顺序：正文、句柄、字节。
    const content = (context.messages[0] as PiUserMessage).content as (TextContent | ImageContent)[];
    assert.equal(content[0]?.type, 'text');
    assert.equal((content[0] as TextContent).text, '看看这个');
    assert.equal((content[1] as TextContent).type, 'text');
    assert.match((content[1] as TextContent).text, /img-1/u, '句柄文本要让模型能引用这张图');
    assert.equal(content[2]?.type, 'image');
    assert.equal((content[2] as ImageContent).mimeType, 'image/png');
    assert.equal((content[2] as ImageContent).data, Buffer.from(new Uint8Array(8)).toString('base64'));
  });

  it('已经卸载过的图片只发句柄，不再发字节', async () => {
    const context = await toPiContext(
      request({
        messages: [createUserMessage({
          content: [{ type: 'image', attachment: imageRef('img-1'), offloaded: true }, { type: 'text', text: '描述一下' }],
          source: { kind: 'user' },
        })],
      }),
      { attachments: attachments() },
    );
    // 一张都不发：整条消息塌成纯文本，因此 pi-ai 侧拿到的是字符串而不是块数组。
    const content = (context.messages[0] as PiUserMessage).content;
    assert.equal(typeof content, 'string', '卸载过的图片不该再产生块');
    assert.match(content as unknown as string, /image omitted to fit request image limits/u);
    assert.match(content as unknown as string, /描述一下/u);
    assert.doesNotMatch(content as unknown as string, /AAAA/u, '一个字节的 base64 都不该上线');
  });

  it('没有附件服务的部署里，带图片的请求响亮拒绝', async () => {
    await assert.rejects(
      () => toPiContext(request({
        messages: [createUserMessage({
          content: [{ type: 'image', attachment: imageRef('img-1') }],
          source: { kind: 'user' },
        })],
      })),
      /没有可用的附件服务/u,
    );
  });

  it('超过请求预算时要求上层先卸载最旧的几张', async () => {
    const messages = [
      createUserMessage({
        content: [
          { type: 'image', attachment: imageRef('img-1') },
          { type: 'image', attachment: imageRef('img-2') },
        ],
        source: { kind: 'user' },
      }),
    ];
    await assert.rejects(
      () => toPiContext(request({ messages }), { attachments: attachments(11_000_000) }),
      /还需要卸载最旧的 1 张/u,
    );
  });
});

describe('assistant 历史的重放', () => {
  const own = {
    kind: REPLAY_KIND,
    version: REPLAY_VERSION,
    api: 'anthropic-messages',
    provider: 'aperture-anthropic-messages',
    model: 'MiniMax-M3',
    responseId: 'msg-1',
    responseModel: 'MiniMax-M3-2026',
    stopReason: 'stop',
  };

  it('自己写的信封原样回填：签名、响应 id 与工具的原生元数据', async () => {
    const context = await toPiContext(request({
      messages: [assistant(
        [
          { type: 'reasoning', text: '想一下' },
          { type: 'text', text: 'pong' },
          { type: 'tool-call', id: 'call-1' as never, name: 'read', arguments: '{"path":"a"}' },
        ],
        {
          response: own,
          blocks: [
            { thinkingSignature: 'sig-1', redacted: false },
            { textSignature: 'txt-1' },
            { thoughtSignature: 'think-1', namespace: 'ns' },
          ],
        },
      )],
    }));

    const message = context.messages[0] as PiAssistantMessage;
    assert.equal(message.provider, 'aperture-anthropic-messages');
    assert.equal(message.responseId, 'msg-1');
    assert.equal(message.responseModel, 'MiniMax-M3-2026');
    assert.deepEqual(message.content, [
      { type: 'thinking', thinking: '想一下', thinkingSignature: 'sig-1', redacted: false },
      { type: 'text', text: 'pong', textSignature: 'txt-1' },
      { type: 'toolCall', id: 'call-1', name: 'read', arguments: { path: 'a' }, thoughtSignature: 'think-1', namespace: 'ns' },
    ]);
    assert.equal(message.stopReason, 'toolUse');
  });

  it('别的适配器写的信封读不出来：思考块丢掉，文本与工具调用照旧，并报一次降级', async () => {
    const degraded: string[] = [];
    const context = await toPiContext(
      request({
        messages: [assistant(
          [
            { type: 'reasoning', text: '想一下' },
            { type: 'text', text: 'pong' },
          ],
          { kind: 'pi-ai', version: 3, message: { thinkingSignature: 'sig-from-llm-pi-ai' } },
        )],
      }),
      undefined,
      (reason) => degraded.push(reason),
    );

    const message = context.messages[0] as PiAssistantMessage;
    assert.deepEqual(message.content, [{ type: 'text', text: 'pong' }], '没有签名的思考块会被 Anthropic 拒绝，只能丢掉');
    assert.equal(message.provider, 'dsh-foreign');
    assert.equal(message.api, 'dsh-foreign');
    assert.deepEqual(degraded, ['重放元数据不可用']);
  });

  it('自己的信封但内容坏了：响亮抛出，而不是降级', async () => {
    await assert.rejects(
      () => toPiContext(request({
        messages: [assistant([{ type: 'text', text: 'pong' }], {
          response: { kind: REPLAY_KIND, version: 99, api: 'x', provider: 'aperture-openai-chat-completions', model: 'm', stopReason: 'stop' },
        })],
      })),
      /版本 99 不是本适配器认得的/u,
    );
  });

  it('历史里的工具参数不是合法 JSON 时抛出，而不是悄悄换成空对象', async () => {
    await assert.rejects(
      () => toPiContext(request({
        messages: [assistant([{ type: 'tool-call', id: 'call-1' as never, name: 'read', arguments: '{oops' }])],
      })),
      /不是合法 JSON/u,
    );
  });
});

describe('无法表示的块一律响亮拒绝', () => {
  it('developer 消息与工具变更块', async () => {
    await assert.rejects(
      () => toPiContext(request({
        messages: [{ role: 'developer', content: [], source: { kind: 'user' } }] as never,
      })),
      /不支持 developer 消息/u,
    );
    await assert.rejects(
      () => toPiContext(request({
        messages: [createUserMessage({
          content: [{ type: 'tool-addition', toolName: 'read' }],
          source: { kind: 'user' },
        })],
      })),
      /工具变更块不在本次请求里表示/u,
    );
  });

  it('文件块（宿主没有投影掉的那条路径）', async () => {
    await assert.rejects(
      () => toPiContext(request({
        messages: [createUserMessage({
          content: [{ type: 'file', attachment: { attachmentId: 'f-1' } as never }],
          source: { kind: 'user' },
        })],
      })),
      /文件块没有被投影成文本/u,
    );
  });

  it('助手消息里的图片', async () => {
    await assert.rejects(
      () => toPiContext(request({
        messages: [assistant([{ type: 'image', attachment: imageRef('img-1') }])],
      })),
      /无法表示 assistant 消息里的图片/u,
    );
  });

  it('要求延迟加载的工具声明', async () => {
    await assert.rejects(
      () => toPiContext(request({
        tools: [{ name: 'read', description: '', parameters: {}, deferLoading: true }],
      })),
      /不支持延迟加载的工具声明/u,
    );
  });
});
