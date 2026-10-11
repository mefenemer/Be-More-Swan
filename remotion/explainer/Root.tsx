// remotion/explainer/Root.tsx — the assistant overview videos (see AssistantExplainer.tsx). Separate
// from remotion/Root.tsx on purpose: that bundle is the one deployed to Lambda for post renders.
import React from 'react';
import { Composition } from 'remotion';
import { AssistantExplainer, FPS, explainerDuration, type ExplainerProps } from './AssistantExplainer';

const SAMPLE: ExplainerProps = {
    name: 'Social Media Assistant',
    headline: 'Your social media, planned, written and scheduled — in your voice.',
    accent: '#ff007f',
    steps: [{ title: 'Connect your accounts', body: 'Link the platforms you post to.' }],
    features: [{ title: 'A review queue that is never empty', body: 'Drafts arrive ahead of your schedule.' }],
    highlights: ['Drafts on your schedule', 'You approve before anything posts'],
};

export const ExplainerRoot: React.FC = () => (
    <Composition
        id="AssistantExplainer"
        component={AssistantExplainer}
        fps={FPS}
        width={1280}
        height={720}
        durationInFrames={explainerDuration(SAMPLE)}
        defaultProps={SAMPLE}
        calculateMetadata={({ props }) => ({ durationInFrames: explainerDuration(props) })}
    />
);
