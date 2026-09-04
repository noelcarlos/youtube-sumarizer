'use client';

import { useTranslations } from 'next-intl';
import { TABS, matchesTab } from '../stages.js';

const TAB_MESSAGE_KEY = {
  ALL: 'all',
  DOWNLOAD: 'download',
  AI_SUMMARIZE: 'aiSummarize',
  INTERPRET_SUMMARY: 'interpretSummary',
  EMAIL: 'email',
  DONE: 'done',
  ERROR: 'error',
};

export function StageTabs({ videos, active, onChange }) {
  const t = useTranslations('Stages');
  return (
    <div className="mb-6 flex flex-wrap gap-1.5">
      {TABS.map((tabKey) => {
        const count = videos.filter((v) => matchesTab(v, tabKey)).length;
        const isActive = tabKey === active;
        return (
          <button
            key={tabKey}
            onClick={() => onChange(tabKey)}
            className={
              'flex items-center gap-1.5 rounded-full px-3.5 py-1.5 text-sm font-medium transition-colors ' +
              (isActive ? 'bg-primary text-white' : 'text-muted hover:bg-zinc-100 hover:text-text')
            }
          >
            {t(TAB_MESSAGE_KEY[tabKey])}
            <span className="font-mono text-xs text-zinc-400">{count}</span>
          </button>
        );
      })}
    </div>
  );
}
