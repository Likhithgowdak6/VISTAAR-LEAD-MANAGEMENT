type Props = {
  /** The backend's `aiCategory` - a playbook key like `birthday`, or `unknown`/absent. */
  aiCategory?: string | null;
};

/**
 * Which of the service playbooks this enquiry is being handled under. Worth its own line because
 * it is not cosmetic: the category decides which questions the AI asks, which brief it reads, and
 * (once the deal is won) which proposal template gets rendered - see the backend's
 * ai-brain/category-playbooks.ts.
 *
 * `unknown` is shown rather than hidden, deliberately. A conversation the AI has not classified
 * yet is running on the generic fallback playbook, and that is the thing an owner would want to
 * notice on a lead that has been talking for a while - hiding it would make the generic case
 * indistinguishable from a correctly classified one.
 */
const ServiceSection = ({ aiCategory }: Props) => {
  const category = (aiCategory ?? '').trim();

  if (category === '') {
    return null;
  }

  const unclassified = category.toLowerCase() === 'unknown';
  const label = unclassified ? 'Not identified yet' : category.replace(/_/g, ' ');

  return (
    <div className="rounded-lg border border-slate-200 p-3">
      <span className="text-xs font-semibold uppercase text-slate-500">Service</span>
      <p
        className={`mt-1 text-sm font-medium capitalize ${
          unclassified ? 'text-slate-400' : 'text-slate-800'
        }`}
      >
        {label}
      </p>
      {unclassified ? (
        <p className="mt-0.5 text-xs text-slate-400">
          Using the general playbook until the lead says what the occasion is.
        </p>
      ) : null}
    </div>
  );
};

export default ServiceSection;
