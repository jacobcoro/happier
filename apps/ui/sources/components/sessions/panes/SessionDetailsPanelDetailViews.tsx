import { SessionPaneLazyLoader } from './SessionPaneLazyLoader';

import type { SessionCommitDetailsViewProps } from '@/components/sessions/files/views/SessionCommitDetailsView';
import type { SessionFileDetailsViewProps } from '@/components/sessions/files/views/SessionFileDetailsView';
import type { SessionScmReviewDetailsViewProps } from '@/components/sessions/files/views/SessionScmReviewDetailsView';
import type { SessionScmStashDetailsViewProps } from '@/components/sessions/files/views/SessionScmStashDetailsView';
import type { SessionTranscriptDetailsViewProps } from '@/components/sessions/panes/details/SessionTranscriptDetailsView';

type SessionSubagentDetailsViewProps = Readonly<{
    sessionId: string;
    scopeId: string;
    subagentId: string;
}>;

const loadSessionFileDetailsView = async () => (await import('@/components/sessions/files/views/SessionFileDetailsView')).SessionFileDetailsView;

export function SessionFileDetailsViewForPanel(props: SessionFileDetailsViewProps) {
    return <SessionPaneLazyLoader testID="session-file-details-loading" load={loadSessionFileDetailsView} props={props} />;
}

const loadSessionCommitDetailsView = async () => (await import('@/components/sessions/files/views/SessionCommitDetailsView')).SessionCommitDetailsView;

export function SessionCommitDetailsViewForPanel(props: SessionCommitDetailsViewProps) {
    return <SessionPaneLazyLoader testID="session-commit-details-loading" load={loadSessionCommitDetailsView} props={props} />;
}

const loadSessionScmReviewDetailsView = async () => (await import('@/components/sessions/files/views/SessionScmReviewDetailsView')).SessionScmReviewDetailsView;

export function SessionScmReviewDetailsViewForPanel(props: SessionScmReviewDetailsViewProps) {
    return <SessionPaneLazyLoader testID="session-scm-review-details-loading" load={loadSessionScmReviewDetailsView} props={props} />;
}

const loadSessionScmStashDetailsView = async () => (await import('@/components/sessions/files/views/SessionScmStashDetailsView')).SessionScmStashDetailsView;

export function SessionScmStashDetailsViewForPanel(props: SessionScmStashDetailsViewProps) {
    return <SessionPaneLazyLoader testID="session-scm-stash-details-loading" load={loadSessionScmStashDetailsView} props={props} />;
}

const loadSessionSubagentDetailsView = async () => (await import('@/components/sessions/agents/details/SessionSubagentDetailsView')).SessionSubagentDetailsView;

export function SessionSubagentDetailsViewForPanel(props: SessionSubagentDetailsViewProps) {
    return <SessionPaneLazyLoader testID="session-subagent-details-loading" load={loadSessionSubagentDetailsView} props={props} />;
}

const loadSessionTranscriptDetailsView = async () => (await import('@/components/sessions/panes/details/SessionTranscriptDetailsView')).SessionTranscriptDetailsView;

export function SessionTranscriptDetailsViewForPanel(props: SessionTranscriptDetailsViewProps) {
    return <SessionPaneLazyLoader testID="session-transcript-details-loading" load={loadSessionTranscriptDetailsView} props={props} />;
}
