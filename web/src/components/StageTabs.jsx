import { TABS, matchesTab } from '../stages.js';

export function StageTabs({ videos, active, onChange }) {
  return (
    <div className="mb-6 flex flex-wrap gap-1.5">
      {TABS.map((tab) => {
        const count = videos.filter((v) => matchesTab(v, tab.key)).length;
        const isActive = tab.key === active;
        return (
          <button
            key={tab.key}
            onClick={() => onChange(tab.key)}
            className={
              'flex items-center gap-1.5 rounded-full px-3.5 py-1.5 text-sm font-medium transition-colors ' +
              (isActive ? 'bg-primary text-white' : 'text-muted hover:bg-zinc-100 hover:text-text')
            }
          >
            {tab.label}
            <span className={'font-mono text-xs ' + (isActive ? 'text-zinc-400' : 'text-zinc-400')}>{count}</span>
          </button>
        );
      })}
    </div>
  );
}
