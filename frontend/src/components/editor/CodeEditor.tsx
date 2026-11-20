import Editor, { type Monaco } from '@monaco-editor/react';
import { useEffect, useImperativeHandle, useRef, useState, type Ref } from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';
import type { editor as MonacoEditor } from 'monaco-editor';
import { CHIP_GROUP_PREFIX, useEditorStore } from '../../store/useEditorStore';
import { useSimulatorStore } from '../../store/useSimulatorStore';
import { useCompileLogsStore } from '../../store/useCompileLogsStore';
import { registerRetroAsm } from './retroAsmLanguage';
import { attachIntellisenseMonaco } from '../../lib/intellisenseRegistry';
import { CHIP_JSON_SCHEMA, CHIP_JSON_SCHEMA_URI } from './chipJsonSchema';
import { defineVelxioThemes, monacoThemeFor } from './monacoThemes';
import { useResolvedTheme } from '../../hooks/useTheme';
import { registerEditorCommand, setEditingPane } from '../../lib/editorCommands';
import { indentationFor, useEditorPreferences, type EditorPreferences, type Indentation } from '../../store/useEditorPreferences';
import { EditorStatusBar, type EditorStatus, type IndentationChange } from './EditorStatusBar';
import { EditorLanguagePicker } from './EditorLanguagePicker';
import { detectEditorLanguage, editorLanguageLabel, getEditorLanguage, renameForEditorLanguage } from '../../lib/editorLanguages';
import { isChipManifestFile, isChipSourceFile } from '../../services/chipFiles';
import { indentationEdits } from './indentationEdits';
import {
  hasDocumentFormatter,
  registerCodeFormatters,
  setFormatterMessages,
} from './codeFormatters';

export interface CodeEditorHandle {
  applyIndentationPreferences: (previous: EditorPreferences) => void;
}

export const CodeEditor = ({ ref, statusBarHost }: {
  ref?: Ref<CodeEditorHandle>;
  statusBarHost?: HTMLElement | null;
}) => {
  const { files, activeFileId, activeGroupId, setFileContent, manifestViewBoardId, revealLocation } =
    useEditorStore();
  const settings = useEditorPreferences();
  const boards = useSimulatorStore((s) => s.boards);
  const theme = monacoThemeFor(useResolvedTheme());
  const activeFile = files.find((f) => f.id === activeFileId);
  const [languagePickerKey, setLanguagePickerKey] = useState<string | null>(null);
  const editorKey = manifestViewBoardId ? `libraries/${manifestViewBoardId}` : `${activeGroupId}/${activeFileId}`;
  // Renaming a file changes its Monaco model URI, even when the file ID stays the same.
  const mountKey = manifestViewBoardId ? editorKey : JSON.stringify([editorKey, activeFile?.name]);
  const language = manifestViewBoardId ? 'json' : getEditorLanguage(activeFile?.name ?? '');
  const isChipProgramFile = activeGroupId.startsWith(CHIP_GROUP_PREFIX) && activeFile &&
    (isChipManifestFile(activeFile.name) || isChipSourceFile(activeFile.name));
  const canRenameLanguage = !!activeFile && !manifestViewBoardId && !isChipProgramFile;
  const defaults = indentationFor(language, settings);
  const { t } = useTranslation();

  // The live editor instance, so the Edit menu's "Format document" can drive
  // Monaco's own format action (the same one the right-click menu and
  // Shift+Alt+F run). Re-set on every file switch: the editor is keyed by
  // file id, so each file is a fresh instance and the old one is disposed.
  const [mounted, setMounted] = useState<{
    key: string;
    editor: MonacoEditor.IStandaloneCodeEditor;
  } | null>(null);
  const instance = mounted?.key === mountKey ? mounted.editor : null;
  const monacoRef = useRef<Monaco | null>(null);


  const compileLogs = useCompileLogsStore((state) => state.logs);
  useEffect(() => {
    const model = instance?.getModel();
    const monaco = monacoRef.current;
    if (!model || !monaco) return;
    const markers: MonacoEditor.IMarkerData[] = [];
    if (activeFile && !manifestViewBoardId) {
      for (const { location } of compileLogs) {
        if (location?.groupId !== activeGroupId || location.fileId !== activeFile.id ||
            location.name !== activeFile.name || location.content !== activeFile.content) continue;
        const position = model.validatePosition(location.position);
        markers.push({
          severity: location.severity === 'error' ? monaco.MarkerSeverity.Error : monaco.MarkerSeverity.Warning,
          source: 'Compiler',
          message: location.message,
          startLineNumber: position.lineNumber,
          startColumn: position.column,
          endLineNumber: position.lineNumber,
          endColumn: model.getWordAtPosition(position)?.endColumn ?? position.column + 1,
        });
      }
    }
    monaco.editor.setModelMarkers(model, 'velxio-compiler', markers);
  }, [instance, compileLogs, activeGroupId, activeFile, manifestViewBoardId]);
  const [editorStatus, setEditorStatus] = useState<{ key: string; value: EditorStatus } | null>(null);
  const overrides = useRef(new Map<string, EditorStatus['indentation']>());
  // File IDs stay stable across edits and moves. Prune them when projects or
  // file groups are replaced so old model settings cannot leak into new files.
  useEffect(() => {
    const prune = (state: ReturnType<typeof useEditorStore.getState>) => {
      const keys = new Set<string>();
      for (const [groupId, group] of Object.entries(state.fileGroups)) {
        for (const file of group) keys.add(`${groupId}/${file.id}`);
      }
      for (const key of overrides.current.keys()) {
        if (!keys.has(key)) overrides.current.delete(key);
      }
    };
    return useEditorStore.subscribe((state, previous) => {
      if (state.fileGroups !== previous.fileGroups) prune(state);
    });
  }, []);

  useEffect(() => {
    const model = instance?.getModel();
    if (!instance || !model) return;

    const existing = overrides.current.get(editorKey);
    if (existing) {
      model.updateOptions(existing);
    } else if (!manifestViewBoardId && settings.detectIndentation) {
      model.detectIndentation(defaults.insertSpaces, defaults.tabSize);
    } else {
      model.updateOptions({ ...defaults, indentSize: defaults.tabSize });
    }

    const update = () => {
      const position = instance.getPosition();
      if (!position) return;
      const { insertSpaces, tabSize, indentSize } = model.getOptions();
      setEditorStatus({
        key: editorKey,
        value: {
          line: position.lineNumber,
          column: instance.getVisibleColumnFromPosition(position),
          indentation: { insertSpaces, tabSize, indentSize },
        },
      });
    };
    const cursor = instance.onDidChangeCursorPosition(update);
    const options = model.onDidChangeOptions(() => {
      if (!manifestViewBoardId) {
        const { insertSpaces, tabSize, indentSize } = model.getOptions();
        overrides.current.set(editorKey, { insertSpaces, tabSize, indentSize });
      }
      update();
    });
    update();
    return () => {
      cursor.dispose();
      options.dispose();
    };
  }, [instance, editorKey, defaults, manifestViewBoardId, settings.detectIndentation]);

  const applyIndentation = (target: Indentation) => {
    const model = instance?.getModel();
    if (!instance || !model || model.isDisposed() || manifestViewBoardId || !activeFile) return;
    const tokens = monacoRef.current?.editor.tokenize(model.getValue(), model.getLanguageId());
    const edits = indentationEdits(model.getLinesContent(), model.getOptions(), target, (index) =>
      tokens?.[index]?.[0]?.type.split('.').includes('string') ?? false,
    );
    if (edits.length) {
      instance.pushUndoStop();
      instance.executeEdits('indentation', edits);
      instance.pushUndoStop();
    }
    const options = { ...target, indentSize: target.tabSize };
    overrides.current.set(editorKey, options);
    model.updateOptions(options);
  };

  useImperativeHandle(ref, () => ({
    applyIndentationPreferences(previous) {
      const before = indentationFor(language, previous);
      const after = indentationFor(language, useEditorPreferences.getState());
      if (before.insertSpaces !== after.insertSpaces || before.tabSize !== after.tabSize) {
        applyIndentation(after);
      }
    },
  }));

  const runIndentationAction = (change: IndentationChange) => {
    if (!instance || manifestViewBoardId || !activeFile) return;
    const model = instance.getModel();
    if (!model || model.isDisposed()) return;
    instance.focus();
    if ('size' in change) {
      if (change.action === 'changeTabDisplaySize') {
        model.updateOptions({ tabSize: change.size, indentSize: model.getOptions().indentSize });
      } else {
        applyIndentation({ insertSpaces: change.action === 'indentUsingSpaces', tabSize: change.size });
      }
      return;
    }
    if (change.action === 'detectIndentation') {
      model.detectIndentation(defaults.insertSpaces, defaults.tabSize);
      const { insertSpaces, tabSize, indentSize } = model.getOptions();
      overrides.current.set(editorKey, { insertSpaces, tabSize, indentSize });
      return;
    }
    void instance.getAction(`editor.action.${change.action}`)?.run();
  };

  useEffect(() => {
    if (!instance || manifestViewBoardId || !revealLocation ||
        revealLocation.fileId !== activeFileId || revealLocation.groupId !== activeGroupId) return;
    const position = instance.getModel()?.validatePosition(revealLocation.position);
    if (!position) return;
    instance.setPosition(position);
    instance.revealPositionInCenter(position);
    instance.focus();
    useEditorStore.getState().setRevealLocation(null);
  }, [instance, activeFileId, activeGroupId, manifestViewBoardId, revealLocation]);

  const statusBar = statusBarHost && createPortal(
    <EditorStatusBar
      key={editorKey}
      status={editorStatus?.key === editorKey ? editorStatus.value : null}
      readOnly={!!manifestViewBoardId || !activeFile}
      onIndentation={runIndentationAction}
      onGoToLine={() => {
        instance?.focus();
        void instance?.getAction('editor.action.gotoLine')?.run();
      }}
      languageLabel={editorLanguageLabel(language)}
      onSelectLanguage={canRenameLanguage ? () => setLanguagePickerKey(editorKey) : undefined}
    />,
    statusBarHost,
  );
  const editorOptions = {
    fontSize: settings.fontSize,
    automaticLayout: true,
    scrollBeyondLastLine: false,
    wordWrap: settings.wordWrap ? 'on' as const : 'off' as const,
    detectIndentation: false,
  };
  useEffect(() => {
    // The read-only libraries.json view swaps the editor out without going
    // through onMount, so the last file's instance would otherwise linger.
    if (!instance || manifestViewBoardId || !hasDocumentFormatter(language)) return;
    return registerEditorCommand('edit.formatDocument', () => {
      if (!instance.getModel()) return; // disposed mid-switch
      instance.focus();
      void instance.getAction('editor.action.formatDocument')?.run();
    });
  }, [instance, language, manifestViewBoardId]);
  useEffect(() => {
    if (!instance || !activeFileId || manifestViewBoardId) return;
    const editActions = [
      ['edit.cut', 'editor.action.clipboardCutAction'],
      ['edit.copy', 'editor.action.clipboardCopyAction'],
      ['edit.paste', 'editor.action.clipboardPasteAction'],
      ['edit.find', 'actions.find'],
      ['edit.replace', 'editor.action.startFindReplaceAction'],
    ] as const;
    const removers = editActions.map(([id, action]) => registerEditorCommand(id, () => {
      if (!instance.getModel()) return;
      instance.focus();
      instance.trigger('editMenu', action, null);
    }));
    return () => removers.forEach((remove) => remove());
  }, [instance, activeFileId, manifestViewBoardId]);
  useEffect(() => {
    if (!instance || !activeFileId || manifestViewBoardId) return;
    let removeUndo: (() => void) | undefined;
    let removeRedo: (() => void) | undefined;
    const editHistory = (action: 'undo' | 'redo') => () => {
      instance.focus();
      instance.trigger('editMenu', action, null);
    };
    const updateHistoryCommands = () => {
      const model = instance.getModel();
      if (model?.canUndo()) {
        removeUndo ??= registerEditorCommand('edit.undo', editHistory('undo'));
      } else {
        removeUndo?.();
        removeUndo = undefined;
      }
      if (model?.canRedo()) {
        removeRedo ??= registerEditorCommand('edit.redo', editHistory('redo'));
      } else {
        removeRedo?.();
        removeRedo = undefined;
      }
    };
    const modelChange = instance.onDidChangeModel(updateHistoryCommands);
    const contentChange = instance.onDidChangeModelContent(() => {
      if (instance.hasTextFocus()) setEditingPane('code');
      updateHistoryCommands();
    });
    const focus = instance.onDidFocusEditorText(() => setEditingPane('code'));
    if (instance.hasTextFocus()) setEditingPane('code');
    updateHistoryCommands();
    return () => {
      modelChange.dispose();
      contentChange.dispose();
      focus.dispose();
      removeUndo?.();
      removeRedo?.();
    };
  }, [instance, activeFileId, manifestViewBoardId]);
  useEffect(() => {
    setFormatterMessages({
      failedTitle: () => t('editor.format.failed', 'Could not format the file'),
    });
  }, [t]);

  // READ-ONLY libraries.json view (the file explorer's libraries.json entry).
  // Shows the active board's declared library manifest as plain-text JSON, live.
  // It is read-only on purpose: adding/removing libraries is done from the
  // Library Manager modal, which edits board.libraries (this just reflects it).
  if (manifestViewBoardId) {
    const b = boards.find((x) => x.id === manifestViewBoardId);
    const content = JSON.stringify({ libraries: b?.libraries ?? [] }, null, 2);
    return (
      <div className="editor-document">
        <Editor
          key={mountKey}
          wrapperProps={{ className: 'editor-document-content' }}
          height="100%"
          language="json"
          theme={theme}
          beforeMount={defineVelxioThemes}
          onMount={(editor) => setMounted({ key: mountKey, editor })}
          value={content}
          options={{
            readOnly: true,
            domReadOnly: true,
            minimap: { enabled: false },
            ...editorOptions,
          }}
        />
        {statusBar}
      </div>
    );
  }

  return (
    <div className="editor-document">
      <Editor
        // key forces a fresh editor instance per file (preserves undo/redo per file)
        key={mountKey}
        wrapperProps={{ className: 'editor-document-content' }}
        height="100%"
        language={language}
        theme={theme}
        value={activeFile?.content ?? ''}
        {...(activeFile && activeFile.name.endsWith('chip.json')
          ? { path: 'velxio-ws/' + activeGroupId + '/' + activeFile.name }
          : {})}
        beforeMount={(monaco: Monaco) => {
          monacoRef.current = monaco;
          // Both velxio themes have to exist before Monaco is asked to use
          // one, or it silently falls back to stock vs-dark.
          defineVelxioThemes(monaco);
          // Register the 8080/Z80 assembly language once so Monaco knows how
          // to tokenize .s / .asm files when they're opened.
          registerRetroAsm(monaco);
          // "Format Document" for C/C++ and Python (idempotent per monaco
          // instance). Monaco adds the context-menu row and Shift+Alt+F by
          // itself once a provider exists.
          registerCodeFormatters(monaco);
          attachIntellisenseMonaco(monaco);
          // Validate chip.json manifests against the schema (idempotent per
          // monaco instance).
          const g = monaco as unknown as { __velxioChipJsonSchema?: boolean };
          if (!g.__velxioChipJsonSchema && monaco.languages.json?.jsonDefaults) {
            g.__velxioChipJsonSchema = true;
            monaco.languages.json.jsonDefaults.setDiagnosticsOptions({
              validate: true,
              schemas: [
                {
                  uri: CHIP_JSON_SCHEMA_URI,
                  fileMatch: ['*chip.json'],
                  schema: CHIP_JSON_SCHEMA,
                },
              ],
            });
          }
        }}
        onMount={(editor) => setMounted({ key: mountKey, editor })}
        onChange={(value) => {
          if (activeFileId) setFileContent(activeFileId, value || '');
        }}
        options={{
          ...editorOptions,
          minimap: { enabled: settings.minimap },
          readOnly: !activeFile,
          // Anchor suggestions to the code pane when the circuit is beside it.
          // Keep quick suggestions alive inside snippet placeholders:
          // completing `#include <|>` or an if-condition placeholder must
          // still offer suggestions while the snippet session is active.
          suggest: { snippetsPreventQuickSuggestions: false },
        }}
      />
      {statusBar}
      {languagePickerKey === editorKey && activeFile && canRenameLanguage && (
        <EditorLanguagePicker
          board={boards.find((board) => board.activeFileGroupId === activeGroupId)}
          onDetectLanguage={() => detectEditorLanguage(activeFile.name, instance?.getValue() ?? activeFile.content)}
          onRename={(nextLanguage) => {
            const name = renameForEditorLanguage(activeFile.name, nextLanguage);
            return useEditorStore.getState().moveWorkspacePath(activeGroupId, activeFile.name, name, false);
          }}
          onClose={() => setLanguagePickerKey(null)}
        />
      )}
    </div>
  );
};
