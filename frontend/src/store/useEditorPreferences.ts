import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import { z } from 'zod';

const preferences = z.object({
  sidebarWidth: z.number().int().min(100).max(500),
  sidebarView: z.enum(['explorer']),
});

export type EditorPreferences = z.infer<typeof preferences>;

const defaults: EditorPreferences = {
  sidebarWidth: 184,
  sidebarView: 'explorer',
};

export const useEditorPreferences = create<
  EditorPreferences & {
    update: (values: Partial<EditorPreferences>) => void;
    reset: () => void;
  }
>()(
  persist(
    (set) => ({
      ...defaults,
      update: (values) => set(values),
      reset: () => set(defaults),
    }),
    {
      name: 'velxio-editor-preferences',
      version: 1,
      partialize: ({ update: _update, reset: _reset, ...values }) => values,
      merge: (stored, current) => {
        const values = preferences.partial().safeParse(stored);
        return values.success ? { ...current, ...values.data } : current;
      },
    },
  ),
);
