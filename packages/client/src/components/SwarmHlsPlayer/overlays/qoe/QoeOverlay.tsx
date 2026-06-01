import React, { useEffect, useRef, useState } from 'react';

import { BarChartIcon } from '@/components/Icons/BarChartIcon';
import { MoveIcon } from '@/components/Icons/MoveIcon';

import { QoeMetrics } from './useHlsQoeMetrics';

import './QoeOverlay.scss';

const DEFAULT_OVERLAY_X_OFFSET = 50;
const DEFAULT_OVERLAY_Y_OFFSET = 10;

interface QoeOverlayProps {
  metrics: QoeMetrics;
}

export const QoeOverlay: React.FC<QoeOverlayProps> = ({ metrics }) => {
  const [visible, setVisible] = useState(true);
  const [pos, setPos] = useState<{ x: number; y: number } | null>(null);
  const [isDragging, setIsDragging] = useState(false);

  const dragging = useRef(false);
  const didDrag = useRef(false);
  const dragOffset = useRef({ x: 0, y: 0 });
  const overlayRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const parentBoundingRect = overlayRef.current?.offsetParent?.getBoundingClientRect();
    if (!parentBoundingRect) {
      return;
    }
    setPos({
      x: parentBoundingRect.width - DEFAULT_OVERLAY_X_OFFSET,
      y: DEFAULT_OVERLAY_Y_OFFSET,
    });
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'q' || e.key === 'Q') {
        setVisible((v) => !v);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  useEffect(() => {
    const onMove = (e: MouseEvent) => {
      if (!dragging.current || !overlayRef.current) {
        return;
      }

      didDrag.current = true;
      const pr = overlayRef.current.offsetParent?.getBoundingClientRect() ?? { left: 0, top: 0 };
      setPos({
        x: e.clientX - dragOffset.current.x - pr.left,
        y: e.clientY - dragOffset.current.y - pr.top,
      });
    };
    const onUp = () => {
      if (!dragging.current) {
        return;
      }

      dragging.current = false;
      setIsDragging(false);
      setTimeout(() => {
        didDrag.current = false;
      }, 0);
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
    return () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    };
  }, []);

  const onMouseDown = (e: React.MouseEvent<HTMLButtonElement>) => {
    if (!overlayRef.current) {
      return;
    }

    const overlayBoundingRect = overlayRef.current.getBoundingClientRect();
    const parentBoundingRect = overlayRef.current.offsetParent?.getBoundingClientRect() ?? { left: 0, top: 0 };

    dragging.current = true;
    didDrag.current = false;
    setIsDragging(true);
    dragOffset.current = { x: e.clientX - overlayBoundingRect.left, y: e.clientY - overlayBoundingRect.top };
    setPos({
      x: overlayBoundingRect.left - parentBoundingRect.left,
      y: overlayBoundingRect.top - parentBoundingRect.top,
    });

    e.preventDefault();
  };

  const handleClick = () => {
    if (!didDrag.current) {
      setVisible((v) => !v);
    }
  };

  const floatStyle: React.CSSProperties | undefined = pos ? { left: pos.x, top: pos.y, right: 'auto' } : undefined;

  return (
    <div ref={overlayRef} className="qoe-overlay" style={floatStyle}>
      <button
        type="button"
        className={['qoe-btn', visible ? 'qoe-btn--active' : '', isDragging ? 'qoe-btn--dragging' : '']
          .filter(Boolean)
          .join(' ')}
        onMouseDown={onMouseDown}
        onClick={handleClick}
        title="Toggle metrics (Q) · Drag to reposition"
      >
        <span className="qoe-btn__chart">
          <BarChartIcon />
        </span>
        <span className="qoe-btn__move">
          <MoveIcon />
        </span>
        {visible && <span className="qoe-btn__live" />}
      </button>

      {visible && <QoePanel metrics={metrics} />}
    </div>
  );
};

const QoePanel: React.FC<{ metrics: QoeMetrics }> = ({ metrics: m }) => (
  <div className="qoe-overlay__panel">
    <div className="qoe-overlay__header">QoE Metrics</div>

    <Section title="Startup">
      <Row label="Startup Time" value={fmtMs(m.startupTimeMs)} />
      <Row label="First Frame Time" value={fmtMs(m.firstFrameTimeMs)} />
      <Row label="Startup Failure" value={m.startupFailed ? 'YES' : 'no'} bad={m.startupFailed} />
    </Section>

    <Section title="Rebuffering">
      <Row label="Count" value={String(m.rebufferingCount)} bad={m.rebufferingCount > 0} />
      <Row label="Duration" value={fmtMs(m.rebufferingDurationMs)} />
      <Row label="Ratio" value={fmtPct(m.rebufferingRatio)} bad={m.rebufferingRatio > 0.01} />
      <Row label="Any Rebuffering" value={m.hadRebuffering ? 'yes' : 'no'} bad={m.hadRebuffering} />
    </Section>

    <Section title="Quality">
      <Row label="Delivered Bitrate" value={m.bitrateKbps != null ? `${m.bitrateKbps} kbps` : '—'} />
      <Row label="Delivered Resolution" value={m.resolution ?? '—'} />
      <Row label="Quality Switches" value={String(m.qualitySwitchCount)} />
      <Row label="Switch Frequency" value={`${m.qualitySwitchPerMin.toFixed(2)}/min`} />
      <Row label="Dropped Frames" value={String(m.droppedFrames)} bad={m.droppedFrames > 0} />
    </Section>

    <Section title="Reliability">
      <Row label="Fatal Errors" value={String(m.fatalErrorCount)} bad={m.fatalErrorCount > 0} />
      <Row label="Fatal Error Rate" value={m.fatalErrorCount > 0 ? 'yes' : 'none'} bad={m.fatalErrorCount > 0} />
      <Row label="Session Complete" value={m.sessionCompleted ? 'yes' : 'in progress'} />
      <Row label="Startup Failure Rate" value={m.startupFailed ? 'failed' : 'ok'} bad={m.startupFailed} />
      <Row label="Reconnect Attempts" value={String(m.reconnectAttempts)} />
      <Row label="Reconnect Success Rate" value={m.reconnectAttempts > 0 ? fmtPct(m.reconnectSuccessRate) : '—'} />
      <Row label="Recovery Time" value={fmtMs(m.lastRecoveryTimeMs)} />
    </Section>

    <Section title="Live">
      <Row label="E2E Live Latency" value={m.liveLatencySec != null ? `${m.liveLatencySec.toFixed(2)} s` : '—'} />
    </Section>

    <div className="qoe-overlay__footer">Playback: {fmtMs(m.playbackTimeMs)}</div>
  </div>
);

const Section: React.FC<{ title: string; children: React.ReactNode }> = ({ title, children }) => (
  <div className="qoe-overlay__section">
    <div className="qoe-overlay__section-title">{title}</div>
    {children}
  </div>
);

const Row: React.FC<{ label: string; value: string; bad?: boolean }> = ({ label, value, bad }) => (
  <div className={`qoe-overlay__row${bad ? ' qoe-overlay__row--bad' : ''}`}>
    <span className="qoe-overlay__label">{label}</span>
    <span className="qoe-overlay__value">{value}</span>
  </div>
);

const fmtMs = (ms: number | null) => (ms == null ? '—' : `${Math.round(ms)} ms`);
const fmtPct = (n: number) => `${(n * 100).toFixed(1)}%`;
