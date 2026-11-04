import { useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { IconSparkles, IconArrowBackUp, IconX, IconCheck, IconAlertTriangle } from '@tabler/icons-react';
import { useApp } from '../store';
import { errorText } from '../api';
import { decideProposal, resolveBoardConflict, undoAgentChange } from '../agentSync';

const SHOW_MS = 20000;

/** Banners for external (agent) changes, review-mode proposals and board conflicts. */
export function AgentBanner() {
  const { t } = useTranslation();
  const { agentChange, proposals, boardConflict, set } = useApp();
  const fail = (e: unknown) => set({ error: errorText(e) });

  useEffect(() => {
    if (!agentChange) return;
    const id = setTimeout(() => set({ agentChange: null }), SHOW_MS);
    return () => clearTimeout(id);
  }, [agentChange, set]);

  const proposal = proposals[0];
  return (
    <div className="banners">
      {boardConflict && (
        <div className="banner warn" role="alert">
          <IconAlertTriangle size={16} />
          <span>{t('agent.conflict')}</span>
          <button className="btn sm" onClick={() => resolveBoardConflict('theirs').catch(fail)}>{t('agent.takeTheirs')}</button>
          <button className="btn sm" onClick={() => resolveBoardConflict('mine').catch(fail)}>{t('agent.keepMine')}</button>
        </div>
      )}
      {proposal && (
        <div className="banner" role="status">
          <IconSparkles size={16} className="ac" />
          <span>
            {t('agent.proposal', { author: proposal.author, stages: proposal.preview.created.length + proposal.preview.updated.length })}
            {proposals.length > 1 && <span className="muted"> · {t('agent.more', { count: proposals.length - 1 })}</span>}
          </span>
          <button className="btn sm pri" onClick={() => decideProposal(proposal.id, true).catch(fail)}><IconCheck size={14} />{t('agent.accept')}</button>
          <button className="btn sm" onClick={() => decideProposal(proposal.id, false).catch(fail)}>{t('agent.reject')}</button>
        </div>
      )}
      {agentChange && (
        <div className="banner" role="status">
          <IconSparkles size={16} className="ac" />
          <span>{t('agent.changed', { stages: agentChange.stages.length, boards: agentChange.boards.length })}</span>
          <button className="btn sm" onClick={() => undoAgentChange().catch(fail)}><IconArrowBackUp size={14} />{t('agent.undo')}</button>
          <button className="icon-btn" aria-label={t('inspector.close')} onClick={() => set({ agentChange: null })}><IconX size={14} /></button>
        </div>
      )}
    </div>
  );
}
