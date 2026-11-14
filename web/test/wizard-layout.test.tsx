import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { describe, expect, it } from 'vitest';
import { FocusLayout } from '../src/components/FocusLayout';
import { RecordPair } from '../src/components/wizard/RecordPair';
import { StepAside, StepCard, StepColumns, StepMain } from '../src/components/wizard/StepCard';

describe('wizard layout', () => {
	it('FocusLayout uses a wide column, not max-w-3xl', () => {
		const { container } = render(
			<MemoryRouter>
				<FocusLayout>
					<p>hi</p>
				</FocusLayout>
			</MemoryRouter>,
		);
		const main = container.querySelector('main');
		expect(main).toHaveClass('max-w-6xl');
		expect(main).not.toHaveClass('max-w-3xl');
	});
	it('StepColumns is two columns from lg, one below; RecordPair is two-up from md', () => {
		const { container } = render(
			<>
				<StepCard title="T">
					<StepColumns>
						<StepAside>a</StepAside>
						<StepMain>b</StepMain>
					</StepColumns>
				</StepCard>
				<RecordPair>x</RecordPair>
			</>,
		);
		expect(container.querySelector('div[class*="lg:grid-cols-"]')).toHaveClass('grid', 'lg:grid-cols-[minmax(0,1fr)_minmax(0,2fr)]');
		expect(screen.getByText('x')).toHaveClass('md:grid-cols-[repeat(2,minmax(0,1fr))]');
	});
});
