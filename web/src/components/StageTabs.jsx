import { TABS, matchesTab } from '../stages.js';

export function StageTabs({ videos, active, onChange }) {
  return (
    <div className="mb-6 flex gap-5 border-b-2 border-ink font-mono text-xs">
      {TABS.map((tab) => {
        const count = videos.filter((v) => matchesTab(v, tab.key)).length;
        const isActive = tab.key === active;
        return (
          <button
            key={tab.key}
            onClick={() => onChange(tab.key)}
            className={
              'flex items-baseline gap-1.5 border-b-2 pb-2 -mb-[2px] font-serif text-sm ' +
              (isActive
                ? 'border-red text-ink font-semibold'
                : 'border-transparent text-ink-dim hover:text-ink')
            }
          >
            {tab.label}
            <span className="font-mono text-[0.68rem] text-ink-dim">{count}</span>
          </button>
        );
      })}
    </div>
  );
}
