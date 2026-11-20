import type { CancellationToken, Position, editor, languages } from 'monaco-editor';
import { includePathPrefix } from './arduinoSymbols';
import { hasIntellisenseImpl } from './intellisenseRegistry';
import type { Candidate } from './codeCompletions';
import { useEditorStore, type WorkspaceFile } from '../store/useEditorStore';
import { useSimulatorStore } from '../store/useSimulatorStore';

type Monaco = typeof import('monaco-editor');

interface Binding {
  groupId: string;
  fileId: string;
  refreshSuggestions: (position: Position) => void;
}

const bindings = new WeakMap<editor.ITextModel, Binding>();
const installed = new WeakSet<Monaco>();
const pendingCompletions = new WeakMap<editor.ITextModel, { version: number }>();

export function completionWasInterrupted(model: editor.ITextModel) {
  const pending = pendingCompletions.get(model);
  return pending !== undefined && pending.version !== model.getVersionId();
}

function trackCompletion(
  provide: languages.CompletionItemProvider['provideCompletionItems'],
): typeof provide {
  return async (model, position, trigger, token) => {
    const request = { version: model.getVersionId() };
    pendingCompletions.set(model, request);
    try {
      return await provide(model, position, trigger, token);
    } finally {
      if (pendingCompletions.get(model) === request) pendingCompletions.delete(model);
    }
  };
}

export function workspaceModelPath(groupId: string, file: WorkspaceFile) {
  const name = file.name.split('/').map(encodeURIComponent).join('/');
  return `velxio-workspace:/${encodeURIComponent(groupId)}/${encodeURIComponent(file.id)}/${name}`;
}

export function bindIntellisenseModel(model: editor.ITextModel, binding: Binding) {
  bindings.set(model, binding);
  return () => {
    if (bindings.get(model) === binding) bindings.delete(model);
  };
}

function current(model: editor.ITextModel) {
  const binding = bindings.get(model);
  const state = useEditorStore.getState();
  if (
    !binding ||
    model.isDisposed() ||
    state.manifestViewBoardId ||
    state.activeGroupId !== binding.groupId ||
    state.activeFileId !== binding.fileId
  )
    return null;
  const files = state.getGroupFiles(binding.groupId);
  const file = files.find(({ id }) => id === binding.fileId);
  const simulator = useSimulatorStore.getState();
  const board = simulator.boards.find(
    ({ activeFileGroupId }) => activeFileGroupId === binding.groupId,
  );
  if (!file) return null;
  const stamp = JSON.stringify([
    board?.id,
    board?.boardKind,
    board?.languageMode,
    board?.libraries,
  ]);
  return { binding, file, files, board, stamp };
}

function snapshot(model: editor.ITextModel, token: CancellationToken) {
  const initial = current(model);
  if (!initial || token.isCancellationRequested) return null;
  const version = model.getVersionId();
  const matchesModel = () => {
    if (model.isDisposed() || model.getVersionId() !== version) return false;
    const latest = current(model);
    return (
      latest?.binding === initial.binding &&
      latest.files === initial.files &&
      latest.stamp === initial.stamp &&
      latest.file.name === initial.file.name
    );
  };
  return {
    ...initial,
    matchesModel,
    fresh: () => !token.isCancellationRequested && matchesModel(),
  };
}

function localItems(
  monaco: Monaco,
  candidates: Candidate[],
  span: languages.CompletionItem['range'],
) {
  return candidates.map(
    (item): languages.CompletionItem => ({
      label: item.label,
      kind: monaco.languages.CompletionItemKind[item.kind],
      detail: item.detail,
      insertText: item.insertText ?? item.label,
      insertTextRules:
        item.kind === 'Snippet'
          ? monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet
          : undefined,
      range: span,
    }),
  );
}

export function registerEditorIntellisense(monaco: Monaco) {
  if (installed.has(monaco)) return;
  installed.add(monaco);
  monaco.languages.registerCompletionItemProvider('yaml', {
    triggerCharacters: [':', ' ', '*'],
    provideCompletionItems: trackCompletion(async (model, position, trigger, token) => {
      const ctx = snapshot(model, token);
      if (!ctx || hasIntellisenseImpl()) return;
      const prefix = model.getLineContent(position.lineNumber).slice(0, position.column - 1);
      if (trigger.triggerCharacter === ' ' && !/(?:^\s+|[:-] )$/.test(prefix)) return;
      const { yamlCandidates } = await import('./yamlCompletions');
      if (!ctx.fresh()) return;
      const offset = model.getOffsetAt(position);
      const { suggestions, start, end } = yamlCandidates(
        ctx.file.name,
        model.getValue(),
        offset,
        ctx.files,
      );
      const column = position.column - (offset - start);
      const span = (last: number) =>
        new monaco.Range(position.lineNumber, column, position.lineNumber, last);
      return {
        suggestions: localItems(monaco, suggestions, {
          insert: span(position.column),
          replace: span(column + end - start),
        }),
      };
    }),
  });

  for (const language of ['cpp', 'c', 'python']) {
    monaco.languages.registerCompletionItemProvider(language, {
      triggerCharacters: language === 'python' ? ['.', ' '] : ['.', '>', ':', '<', '"', '/', '#'],
      provideCompletionItems: trackCompletion(async (model, position, trigger, token) => {
        const ctx = snapshot(model, token);
        if (!ctx || hasIntellisenseImpl()) return;
        const { file, board, files } = ctx;
        const prefix = model.getLineContent(position.lineNumber).slice(0, position.column - 1);
        const header = language !== 'python' ? includePathPrefix(prefix) : undefined;
        const ch = trigger.triggerCharacter;
        if (ch === ' ' && !/^\s*(?:from(?:\s+[\w.]+\s+import)?|import) $/.test(prefix)) return;
        if (ch && ['<', '"', '/'].includes(ch) && header === undefined) return;
        if ((ch === '>' && !prefix.endsWith('->')) || (ch === ':' && !prefix.endsWith('::')))
          return;
        const headers = files.map((f) => f.name).filter((name) => /\.(h|hpp|hh|hxx)$/i.test(name));
        const word = model.getWordUntilPosition(position);
        const span = new monaco.Range(
          position.lineNumber,
          header !== undefined ? position.column - header.length : word.startColumn,
          position.lineNumber,
          position.column,
        );
        const { codeCandidates, standardHeaders } = await import('./codeCompletions');
        if (!ctx.fresh()) return;
        const local =
          header !== undefined
            ? localItems(
                monaco,
                [
                  ...headers.map((label): Candidate => ({ label, kind: 'File' })),
                  ...standardHeaders,
                ],
                span,
              )
            : localItems(
                monaco,
                codeCandidates(
                  file,
                  files,
                  model.getOffsetAt(position),
                  prefix,
                  board?.languageMode === 'micropython',
                ),
                span,
              );
        if (ctx.fresh() && !hasIntellisenseImpl()) return { suggestions: local };
      }),
    });
  }
}
