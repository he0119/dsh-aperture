/**
 * `aperturePanel` Remote 面的两端契约，以及宿主服务的纯委托。
 *
 * 这一面是手工登记的：生成描述符的 Typert 生成器不随 DSH 发布，而两半边（这里与
 * `client/aperture.js`）共享同一组端点名，谁写错一个字都不会有编译期报错，只会在浏览器里
 * 安静地什么都不出现。因此这里钉住的是那份契约本身——端点 id 的文法与命名空间、参数的名字与
 * 顺序（网关按顺序位置传入，名字对不上就是把 `patch` 当成了模型 id）、编解码器的模式、以及
 * 端点名绝不能撞上 `RemoteNamespaceService` 的预置成员（撞上时注册表会撤回**整份**贡献）。
 *
 * 宿主服务那半边只剩委托：`AperturePanelService` 的每个方法都必须原样把参数交给注入的
 * `PanelOps` 并原样返回它的结果，不加解释、不吞异常——配置页看到的每一句话都来自 `ops`。
 *
 * @module dsh-aperture/test/remote
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { Context } from '@deepseek-ai/cordis';
import type { InvocationDescriptor } from '@deepseek-ai/dsh-typert-protocol';
import type { PanelAction, PanelOps } from '../src/panel.ts';
import type { PanelReport } from '../src/report.ts';
import {
  AperturePanelService,
  PANEL_CONTRIBUTION,
  PANEL_INVOCATIONS,
  PANEL_NAMESPACE,
  PANEL_PACKAGE,
} from '../src/remote.ts';

/** 端点的宿主方法名，顺序与 `PANEL_INVOCATIONS` 一致。 */
const METHODS = ['status', 'refresh', 'edit'] as const;

/** 其中一个端点方法名。 */
type PanelMethod = (typeof METHODS)[number];

/**
 * api-gateway 为每个命名空间建一个 `RemoteNamespaceService`，端点会成为它的属性。
 *
 * 与它自己的成员重名会被 `validateContribution` 拒绝，而且是**整份贡献一起撤回**（浏览器里
 * 只剩一行 console.error）。这份名单抄自 `src/remote.ts` 的模块注释，新端点起名前先对一遍。
 */
const RESERVED_NAMES = [
  'ctx',
  'empty',
  'invokeRemote',
  'methods',
  'name',
  'namespace',
  'has',
  'install',
  'installDirect',
  'installScoped',
  'assertMethodAvailable',
  'remove',
] as const;

/** 按方法名找出那一个描述符；找不到就是契约自己破了。 */
function descriptorOf(method: string): InvocationDescriptor {
  const found = PANEL_INVOCATIONS.find((entry) => entry.method === method);
  assert.ok(found !== undefined, `PANEL_INVOCATIONS 里应当有 ${method} 这个端点`);
  return found;
}

/**
 * 从宿主方法的源码里读出形参名。
 *
 * 网关按描述符里的顺序**位置传入** wire 参数，所以描述符里写的名字与顺序必须与宿主方法的形参
 * 逐一对应。运行时的类型标注已被剥掉，形参名是这里唯一还能读到的声明——正是这一条让「两边
 * 说的是同一个人」可以被验证，而不是靠人去比对两份手写清单。
 *
 * @param method - 端点方法名。
 * @returns 按声明顺序排列的形参名。
 */
function formalParameters(method: PanelMethod): string[] {
  const source = (AperturePanelService.prototype[method] as (...args: unknown[]) => unknown).toString();
  const match = /^[^(]*\(([^)]*)\)/u.exec(source);
  assert.ok(match !== null, `${method} 的源码里应当有形参表`);
  return (match[1] ?? '')
    .split(',')
    .map((entry) => entry.trim().split(/\s+/u)[0] ?? '')
    .filter((name) => name.length > 0);
}

/** 一份把每次调用原样记下来的 `PanelOps` 替身；返回值都是哨兵，好让「原样返回」看得见。 */
function recordingOps(): {
  ops: PanelOps;
  calls: Array<{ method: string; args: readonly unknown[] }>;
  report: PanelReport;
  action: PanelAction;
} {
  const calls: Array<{ method: string; args: readonly unknown[] }> = [];
  const report = { marker: 'report' } as unknown as PanelReport;
  const action: PanelAction = { ok: true, summary: '替身给的回答' };

  const ops: PanelOps = {
    status(): PanelReport {
      calls.push({ method: 'status', args: [] });
      return report;
    },
    async refresh(): Promise<PanelAction> {
      calls.push({ method: 'refresh', args: [] });
      return action;
    },
    async edit(id, patch): Promise<PanelAction> {
      calls.push({ method: 'edit', args: [id, patch] });
      return action;
    },
  };
  return { ops, calls, report, action };
}

/**
 * 只满足 Cordis `Service` 注册所需的最小上下文。
 *
 * `TypertRemoteService` 的构造最终走到 `Service` 的 `super(ctx, name)`，而它只做一件事：
 * `ctx.reflect.provide(name, this, ...)`。这里因此只给一个 `reflect.provide`，把它记下来——
 * 真的 `Context` 不必参与，「服务注册在哪个名字下」这件事仍然是插件自己的行为。
 */
function stubContext(): { ctx: Context; provided: Array<{ name: string; value: unknown }> } {
  const provided: Array<{ name: string; value: unknown }> = [];
  const ctx = {
    reflect: {
      provide(name: string, value: unknown): void {
        provided.push({ name, value });
      },
    },
  } as unknown as Context;
  return { ctx, provided };
}

describe('PANEL_INVOCATIONS 的端点身份', () => {
  it('id、服务名与命名空间按同一份文法拼出，且只声明一个直调', () => {
    assert.deepEqual(
      PANEL_INVOCATIONS.map((entry) => entry.method),
      [...METHODS],
      '端点表就是宿主服务的三个方法，顺序也一样',
    );

    for (const entry of PANEL_INVOCATIONS) {
      // 浏览器右半边（`client/aperture.js`）按同一份文法拼出 `${PACKAGE}#${PANEL}/${method}`，
      // 网关、注册表与客户端三方共用它。
      assert.equal(entry.id, `${PANEL_PACKAGE}#${PANEL_NAMESPACE}/${entry.method}`, `${entry.method} 的端点 id`);
      assert.equal(entry.service, PANEL_NAMESPACE, `${entry.method} 的服务名`);
      assert.equal(entry.namespace, PANEL_NAMESPACE, `${entry.method} 的线上命名空间`);
      assert.deepEqual(entry.invocation, { kind: 'direct' }, `${entry.method} 是直调，没有作用域`);
      assert.equal(entry.implementation, undefined, '端点名就是实例方法名，不需要别名');
      assert.equal(entry.mode, undefined, '三个端点都是一元的：没有流式端点');
      assert.equal(entry.cancellation, undefined, '没有端点读取消信号');
    }

    assert.equal(new Set(PANEL_INVOCATIONS.map((entry) => entry.id)).size, PANEL_INVOCATIONS.length, 'id 不重复');
  });

  it('参数表与宿主方法的形参同名、同序', () => {
    // 网关按描述符顺序位置传入，名字只用于拼 wire 的 `args`；两处任何一处错位都表现为
    // 「界面保存了，但写进去的是另一个字段」。
    assert.deepEqual(formalParameters('edit'), ['id', 'patch']);

    for (const method of METHODS) {
      const entry = descriptorOf(method);
      assert.deepEqual(
        entry.parameters.map((parameter) => parameter.name),
        formalParameters(method),
        `${method} 的描述符参数与宿主形参同名同序`,
      );
      for (const parameter of entry.parameters) {
        assert.equal(parameter.wire, parameter.name, 'wire 名与源码名一致，网关与浏览器读的是同一个键');
        assert.equal(parameter.source, 'json', '参数只走 JSON，不需要宿主侧查找');
      }
      assert.equal(entry.parameters.length, AperturePanelService.prototype[method].length, `${method} 的参数个数`);
    }

    assert.deepEqual(descriptorOf('edit').parameters.map((parameter) => parameter.wire), ['id', 'patch']);
    for (const method of ['status', 'refresh'] as const) {
      assert.deepEqual(descriptorOf(method).parameters, [], `${method} 不收任何参数`);
    }
  });

  it('宿主侧描述符用 src-json 编解码器', () => {
    // 宿主这一半交接的是已经解析好的值，因此按 `src-json` 登记——strict 校验与 `create()`
    // 工厂是**浏览器那一半**（`client/aperture.js` 里的直通 CODEC）的事，两边不是同一份描述符。
    for (const entry of PANEL_INVOCATIONS) {
      assert.equal(entry.result.mode, 'src-json', `${entry.method} 的结果编解码器`);
      for (const parameter of entry.parameters) {
        assert.equal(parameter.codec.mode, 'src-json', `${entry.method} 的参数编解码器`);
        assert.equal('create' in parameter.codec, false, 'src-json 没有 create() 工厂，值直接交给网关');
      }
    }
  });

  it('端点名不会撞上 RemoteNamespaceService 的预置成员', () => {
    const reserved = new Set<string>(RESERVED_NAMES);
    for (const entry of PANEL_INVOCATIONS) {
      assert.equal(reserved.has(entry.method), false, `端点名 "${entry.method}" 撞上了命名空间服务的成员，整份贡献会被撤回`);
    }
  });
});

describe('PANEL_CONTRIBUTION', () => {
  it('是宿主面，带上同一份端点表，且不声明 schema 与 model', () => {
    assert.equal(PANEL_CONTRIBUTION.package, PANEL_PACKAGE);
    assert.equal(PANEL_CONTRIBUTION.face, 'host', '这份描述符是宿主半边登记的');
    // 同一份数组，而不是复制一份：两端共享的就是这一组端点。
    assert.equal(PANEL_CONTRIBUTION.invocations, PANEL_INVOCATIONS);
    // schemas/model 是 Typert 生成器的产物，本插件没有生成器，因此它们如实为空：端点仍然
    // 完整——宿主注册 src-json、浏览器带 strict 校验，两者按同一份契约工作。
    assert.deepEqual(PANEL_CONTRIBUTION.schemas, []);
    assert.deepEqual(PANEL_CONTRIBUTION.model, { services: [], events: [], objects: [] });
  });
});

describe('AperturePanelService', () => {
  it('三个方法一一委托给 PanelOps，原样传参并原样返回', async () => {
    const recorded = recordingOps();
    const { ctx } = stubContext();
    const panel = new AperturePanelService(ctx, recorded.ops);
    const patch = { contextWindow: 8192 };

    assert.equal(panel.status(), recorded.report, 'status 原样返回 ops 的报告');
    assert.equal(await panel.refresh(), recorded.action, 'refresh 原样返回 ops 的结论');
    assert.equal(await panel.edit('deepseek-flash', patch), recorded.action);
    // `null` 是「撤销这个模型的全部覆盖」，缺失是调用方写错了：服务这一层不许把它归一化。
    assert.equal(await panel.edit('deepseek-flash', null), recorded.action);

    assert.deepEqual(recorded.calls, [
      { method: 'status', args: [] },
      { method: 'refresh', args: [] },
      { method: 'edit', args: ['deepseek-flash', patch] },
      { method: 'edit', args: ['deepseek-flash', null] },
    ]);
  });

  it('注册在命名空间这个名字下，Typert 绑定也指向它', () => {
    const recorded = recordingOps();
    const { ctx, provided } = stubContext();
    const panel = new AperturePanelService(ctx, recorded.ops);

    // 浏览器半边注入的是 `remote.aperturePanel`：注册名、描述符里的 service/namespace 三者
    // 必须是同一个字符串，否则 `$mount` 找不到这个服务。
    assert.equal(panel.name, PANEL_NAMESPACE);
    assert.equal(panel.typertRemote.namespace, PANEL_NAMESPACE);
    assert.equal(panel.typertRemote.serviceKey, PANEL_NAMESPACE);
    assert.equal(panel.typertRemote.service, panel, '绑定说的是这个实例自己');
    assert.equal(provided.length, 1, 'super(ctx, name) 就地把服务注册进上下文');
    assert.equal(provided[0]?.name, PANEL_NAMESPACE);
    assert.equal(provided[0]?.value, panel);
  });
});
