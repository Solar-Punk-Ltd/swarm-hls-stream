import { useRef, useState } from 'react';

import { useAppContext } from '@/providers/App';
import { config } from '@/utils/config';

import { describeProbeOutcome, gatewayLabel, normalizeGatewayUrl, probeGateway } from './gatewayProbe';

import './DomainSelector.scss';

const KEY_ENTER = 'Enter';
const KEY_ESCAPE = 'Escape';

type Status = { kind: 'idle' } | { kind: 'checking' } | { kind: 'ok'; text: string } | { kind: 'error'; text: string };

const IDLE: Status = { kind: 'idle' };

/**
 * The picker a viewer uses to watch through their own Bee node instead of this site's gateway.
 *
 * Nothing is saved until the address has answered a health check, so a typo or a node that refuses
 * this site's origin is reported here, in words, rather than showing up later as a catalog with
 * nothing in it. The default gateway is one click away again, because the viewer who tried their own
 * node and gave up needs a way back that is not "clear site data".
 */
export function DomainSelector() {
  const { gatewayUrl, setGatewayUrl } = useAppContext();
  const [isOpen, setIsOpen] = useState(false);
  const [inputValue, setInputValue] = useState(gatewayUrl);
  const [status, setStatus] = useState<Status>(IDLE);
  // Bumped on every confirm and on close, so a probe that comes back after the viewer cancelled or
  // retyped cannot save a URL they no longer meant.
  const probeGeneration = useRef(0);

  const isOnDefault = gatewayUrl === config.beeUrl;

  const handleOpen = () => {
    setInputValue(isOnDefault ? '' : gatewayUrl);
    setStatus(IDLE);
    setIsOpen(true);
  };

  const close = () => {
    probeGeneration.current += 1;
    setIsOpen(false);
  };

  const handleConfirm = async () => {
    if (status.kind === 'checking') {
      return;
    }
    const candidate = normalizeGatewayUrl(inputValue);
    if (!candidate) {
      setStatus({ kind: 'error', text: 'Enter the address of your Bee node, for example http://localhost:1633.' });
      return;
    }
    const generation = ++probeGeneration.current;
    setStatus({ kind: 'checking' });
    const outcome = await probeGateway(candidate);
    if (generation !== probeGeneration.current) {
      return;
    }
    if (outcome.kind === 'ok') {
      setGatewayUrl(candidate);
      close();
      return;
    }
    setStatus({ kind: 'error', text: describeProbeOutcome(outcome) });
  };

  const handleUseDefault = () => {
    setGatewayUrl(config.beeUrl);
    close();
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === KEY_ENTER) {
      handleConfirm();
    }
    if (e.key === KEY_ESCAPE) {
      close();
    }
  };

  return (
    <>
      <button className="gateway-button" onClick={handleOpen} title="Choose which Bee node streams load through">
        <span className="gateway-button-label">Bee node</span>
        <span className="gateway-button-current">{gatewayLabel(gatewayUrl, config.beeUrl)}</span>
      </button>

      {isOpen && (
        <div className="gateway-modal-backdrop" onClick={close}>
          <div className="gateway-modal" onClick={(e) => e.stopPropagation()}>
            <h3 className="gateway-modal-title">Watch through your own Bee node</h3>
            <p className="gateway-modal-description">
              Streams normally load through this site&apos;s gateway. If you run a Bee node, for example with Swarm
              Desktop, enter its address and the video will be fetched by your node instead.
            </p>
            <input
              className="gateway-modal-input"
              type="text"
              autoFocus
              value={inputValue}
              onChange={(e) => {
                setInputValue(e.target.value);
                if (status.kind !== 'idle') {
                  probeGeneration.current += 1;
                  setStatus(IDLE);
                }
              }}
              onKeyDown={handleKeyDown}
              placeholder="http://localhost:1633"
            />
            <p className={`gateway-modal-status ${status.kind}`} role="status">
              {status.kind === 'checking' && 'Checking the node...'}
              {(status.kind === 'ok' || status.kind === 'error') && status.text}
            </p>
            <div className="gateway-modal-actions">
              {!isOnDefault && (
                <button className="gateway-modal-default" onClick={handleUseDefault}>
                  Back to default gateway
                </button>
              )}
              <span className="gateway-modal-actions-spacer" />
              <button className="gateway-modal-cancel" onClick={close}>
                Cancel
              </button>
              <button className="gateway-modal-confirm" onClick={handleConfirm} disabled={status.kind === 'checking'}>
                {status.kind === 'checking' ? 'Checking...' : 'Check and use'}
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
