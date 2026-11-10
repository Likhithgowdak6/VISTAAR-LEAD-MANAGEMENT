import { useState } from 'react';
import StagesPage from './StagesPage';
import TagsPage from './TagsPage';

export type StagesAndTagsTab = 'stages' | 'tags';

interface Props {
  defaultTab?: StagesAndTagsTab;
}

const StagesAndTagsPage = ({ defaultTab = 'stages' }: Props) => {
  const [activeTab, setActiveTab] = useState<StagesAndTagsTab>(defaultTab);

  return (
    <div className="mx-auto max-w-3xl space-y-5 p-4 sm:p-6 lg:p-8 animate-fade-in">
      {/* Page Header */}
      <div>
        <h1 className="text-xl sm:text-2xl font-bold tracking-tight text-slate-900 dark:text-slate-100">
          Stages &amp; Tags
        </h1>
        <p className="mt-1 text-xs sm:text-sm text-slate-500 dark:text-slate-400">
          Configure your sales pipeline progression stages and organize customer categorization tags.
        </p>
      </div>

      {/* Segmented Tab Controls */}
      <div className="flex items-center gap-1.5 p-1 rounded-xl bg-slate-200/70 dark:bg-slate-800/80 w-fit">
        <button
          type="button"
          onClick={() => setActiveTab('stages')}
          aria-selected={activeTab === 'stages'}
          className={`flex items-center gap-2 px-4 py-2 rounded-lg text-xs sm:text-sm font-semibold transition-all duration-150 ${
            activeTab === 'stages'
              ? 'bg-white dark:bg-slate-900 text-blue-600 dark:text-blue-400 shadow-xs'
              : 'text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-slate-200'
          }`}
        >
          <span>🎯</span>
          <span>Pipeline Stages</span>
        </button>

        <button
          type="button"
          onClick={() => setActiveTab('tags')}
          aria-selected={activeTab === 'tags'}
          className={`flex items-center gap-2 px-4 py-2 rounded-lg text-xs sm:text-sm font-semibold transition-all duration-150 ${
            activeTab === 'tags'
              ? 'bg-white dark:bg-slate-900 text-blue-600 dark:text-blue-400 shadow-xs'
              : 'text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-slate-200'
          }`}
        >
          <span>🏷️</span>
          <span>Lead Tags</span>
        </button>
      </div>

      {/* Tab Content */}
      <div className="pt-2">
        {activeTab === 'stages' ? (
          <StagesPage embedded />
        ) : (
          <TagsPage embedded />
        )}
      </div>
    </div>
  );
};

export default StagesAndTagsPage;
