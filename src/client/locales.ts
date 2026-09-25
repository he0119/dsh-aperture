/**
 * 本插件的字典：两份语言、命名空间，以及没有注入 `t` 时的兜底插值。
 *
 * 命名空间在这里声明（`LocaleNamespaceMap` 的那一处 merge）：`ctx.locale.register(NS, { zh, en })`
 * 因此会按 `zh` 的键集校验两份字典——少一个键、多一个键都是编译错误，双语必须一次交齐；
 * 配置页注册时的 `locale: NS` 也才认得它。
 *
 * @module dsh-aperture/client/locales
 */

export const zh = {
  save: '保存',
  saving: '保存中…',
  saveFailed: '没被接受：文档可能只读，或刚被别处改过',
  readOnly: '这份设置是只读的，改不动。',
  unavailable: '这一份设置现在读不到：宿主没有把 aperture 段服务给这个页面。',

  addressLabel: '实例地址',
  addressHint: '填 Aperture 的地址；留空即休眠，不再发现模型。',
  addressPlaceholder: 'http://127.0.0.1:54117',
  syncLabel: '自动同步',
  syncHint: '每轮发现之后，把模型与参数写进 dsh 的 llm-pi-ai 路由。',

  overridden: '已覆盖',
  overriddenCount: '已覆盖 {count} 项',
  resetField: '恢复默认',
  invalidField: '要填不小于 1 的整数，或留空',

  refresh: '立刻刷新',
  refreshHint: '立刻重新发现并发布一次，清单与每一行的状态都按这一轮刷新。',
  refreshing: '刷新中…',
  loading: '读取中…',

  configRefused: '设置已被别处改过，这次改动没有写入：刷新页面后再改一遍。',
  savedResult: '已保存：{result}',
  noChanges: '没有改动，因此没有写入。',
  invalidNumber: '{field} 只能填不小于 1 的整数。',

  // 「发现报告」那一块删掉之后留下的三句：没有地址时的空状态，以及这一轮两处可能出问题的地方。
  dormantHint: '还没有实例地址：填上并保存之后才会去发现模型。',
  catalogUnavailable: '清单不可用（{reason}）',
  syncSkipped: '没写（{reason}）',

  modelsTitle: '模型',
  modelsHint: '一行一个模型；展开改这一行的覆盖，「保存」只写这一行。顺序来自发现顺序，没有路由可服务的排在最后。',
  modelsCount: '{count} 个',
  noModels: '还没有发现任何模型。',
  unservedTag: '未服务',
  dirtyTag: '有未保存的改动',
  statusUnserved: '没有路由能服务这个模型',
  statusUnknown: '这一轮没有同步，写没写进去看不出来',
  statusPublished: '已写入 dsh 的路由',
  statusNotPublished: '还没写进 dsh 的路由',

  factContextWindow: '上下文 {count}',
  factMaxTokens: '输出 {count}',
  factRoute: '路由 {route}',
  factProtocol: '协议 {protocol}',
  factInput: '模态 {value}',
  factReasoning: '推理 {value}',
  factAlias: '别名 {alias}',
  factEndpoints: '网关通告的端点：',
  factSource: '来源：{source}',

  modalityText: '文本',
  modalityImage: '图片',
  modalityNone: '无',
  reasoningFollow: '跟随发现',
  reasoningOn: '开',
  reasoningOff: '关',

  sourceAperture: 'Aperture',
  sourceModelsDev: 'models.dev',
  sourceConfig: '配置',
  sourceDefault: '默认值',

  editName: '显示名',
  editApi: '协议',
  editContextWindow: '上下文容量',
  editMaxTokens: '最大输出',
  editInput: '请求模态',
  editReasoning: '推理',
  editAlias: '清单别名',
  editNameHint: '留空即用发现到的名字。',
  editApiHint: '未服务的模型只有这里能救：填上协议它才有路由；留空即用网关通告的协议。',
  editCapacityHint: '可以写 1M、384K；留空即用发现到的容量。',
  editAliasHint: '写进 llm-pi-ai 清单的别名。',
  editInputHint: '这里能覆盖报告说它接收的模态。',
  editReasoningHint: '「跟随发现」就是这一项不写。',
  fieldHelp: '{field}的说明',
  editGroupIdentity: '名称与协议',
  editGroupCapacity: '容量',
  editUnknownOverrides: '这一行还有界面改不动的覆盖（{keys}）：清空覆盖会整条删掉。',
  pendingChanges: '有 {count} 项改动还没写下去',
  noPendingChanges: '和已保存的值相同',
  saveRow: '保存',
  clearOverrides: '清空覆盖',
  cancelRow: '取消',
  keyReasoningEfforts: '推理档位',
  listSeparator: '、',
};

export const en = {
  save: 'Save',
  saving: 'Saving…',
  saveFailed: 'not accepted: the document may be read-only, or just changed elsewhere',
  readOnly: 'These settings are read-only, so nothing can be changed here.',
  unavailable: 'These settings cannot be read right now: the Host does not serve the aperture section to this page.',

  addressLabel: 'Instance address',
  addressHint: 'Where Aperture listens; leave it empty to go dormant and stop discovering models.',
  addressPlaceholder: 'http://127.0.0.1:54117',
  syncLabel: 'Sync automatically',
  syncHint: 'After each discovery round, write the models and their parameters into dsh\u2019s llm-pi-ai routes.',

  overridden: 'overridden',
  overriddenCount: '{count} overridden',
  resetField: 'Reset to default',
  invalidField: 'Enter an integer of at least 1, or leave it empty',

  refresh: 'Refresh now',
  refreshHint: 'Discover and republish once; the list and every row’s status follow this round.',
  refreshing: 'Refreshing…',
  loading: 'Loading…',

  configRefused: 'These settings changed elsewhere, so this edit was not written. Reload the page and try again.',
  savedResult: 'Saved: {result}',
  noChanges: 'Nothing changed, so nothing was written.',
  invalidNumber: '{field} takes an integer of at least 1.',

  // What is left of the deleted discovery report: the empty state without an address, plus the two
  // things that can go wrong in a round.
  dormantHint: 'No instance address yet: models are discovered once you set and save one.',
  catalogUnavailable: 'catalog unavailable ({reason})',
  syncSkipped: 'skipped ({reason})',

  modelsTitle: 'Models',
  modelsHint: 'One model per row; expand a row to edit its overrides, and Save writes only that row. The order comes from discovery, with anything no route can serve last.',
  modelsCount: '{count} models',
  noModels: 'No models discovered yet.',
  unservedTag: 'unserved',
  dirtyTag: 'unsaved edits',
  statusUnserved: 'No route can serve this model',
  statusUnknown: 'This round synced nothing, so whether it was written is unknown',
  statusPublished: 'Written into the dsh routes',
  statusNotPublished: 'Not written into the dsh routes yet',

  factContextWindow: '{count} context',
  factMaxTokens: 'output {count}',
  factRoute: 'route {route}',
  factProtocol: 'protocol {protocol}',
  factInput: 'modalities {value}',
  factReasoning: 'reasoning {value}',
  factAlias: 'alias {alias}',
  factEndpoints: 'Endpoints the gateway advertises:',
  factSource: 'Source: {source}',

  modalityText: 'text',
  modalityImage: 'image',
  modalityNone: 'none',
  reasoningFollow: 'Follow discovery',
  reasoningOn: 'On',
  reasoningOff: 'Off',

  sourceAperture: 'Aperture',
  sourceModelsDev: 'models.dev',
  sourceConfig: 'config',
  sourceDefault: 'default',

  editName: 'Display name',
  editApi: 'Protocol',
  editContextWindow: 'Context window',
  editMaxTokens: 'Max output',
  editInput: 'Request modalities',
  editReasoning: 'Reasoning',
  editAlias: 'Catalog alias',
  editNameHint: 'Leave it empty to use the discovered name.',
  editApiHint: 'The only way an unserved model gets a route is a protocol here; leave it empty to use the advertised one.',
  editCapacityHint: 'Write 1M or 384K; leave it empty to use the discovered capacity.',
  editAliasHint: 'The alias written into the llm-pi-ai catalog.',
  editInputHint: 'This overrides the modalities the report says it accepts.',
  editReasoningHint: '\u201cFollow discovery\u201d leaves this key unwritten.',
  fieldHelp: 'About {field}',
  editGroupIdentity: 'Name and protocol',
  editGroupCapacity: 'Capacity',
  editUnknownOverrides: 'This row also carries overrides this page cannot edit ({keys}); clearing overrides removes the whole entry.',
  pendingChanges: '{count} edits not written yet',
  noPendingChanges: 'Matches the saved values',
  saveRow: 'Save',
  clearOverrides: 'Clear overrides',
  cancelRow: 'Cancel',
  keyReasoningEfforts: 'reasoning efforts',
  listSeparator: ', ',
};

/** 内置中文兜底按普通字典读（`t` 缺席时用它，键集由下面的 `LocaleNamespaceMap` 声明）。 */
export const zhDict: Record<string, string> = zh;

/** 本插件字典的键（内置中文那一份的键集就是权威，`LocaleNamespaceMap` 按它声明）。 */
export type LocaleKey = keyof typeof zh;

/** 字典命名空间（本插件拥有）；配置页注册时的 `locale` 声明与 `ctx.locale.bind` 都用它。 */
export const NS = 'settings.aperturePanel';

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    'settings.aperturePanel': LocaleKey;
  }
}

/**
 * 把 `{name}` 占位符换成实参。locale 服务自己做这件事，这里只是没有注入 `t` 时（测试、以及
 * 渲染器还没绑定字典时）用同一套规则兜底——否则字典里的模板会原样漏到界面上。
 *
 * @returns {string} 填好的字符串。
 */
export function interpolate(template: string, params?: Record<string, unknown>): string {
  if (params === undefined) return template;
  return template.replace(/\{(\w+)\}/gu, (match, name) => (
    Object.prototype.hasOwnProperty.call(params, name) ? String(params[name]) : match
  ));
}
