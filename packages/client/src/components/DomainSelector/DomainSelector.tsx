import { useRef, useState } from 'react';

import { useAppContext } from '@/providers/App';

import './DomainSelector.scss';

const KEY_ENTER = 'Enter';
const KEY_ESCAPE = 'Escape';

export function DomainSelector() {
  const { gatewayUrl, setGatewayUrl } = useAppContext();
  const [isOpen, setIsOpen] = useState(false);
  const [inputValue, setInputValue] = useState(gatewayUrl);
  const inputRef = useRef<HTMLInputElement>(null);

  const handleOpen = () => {
    setInputValue(gatewayUrl);
    setIsOpen(true);
  };

  const handleConfirm = () => {
    const trimmed = inputValue.trim().replace(/\/+$/, '');
    if (trimmed) {
      setGatewayUrl(trimmed);
    }
    setIsOpen(false);
  };

  const handleCancel = () => {
    setIsOpen(false);
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === KEY_ENTER) {
      handleConfirm();
    }
    if (e.key === KEY_ESCAPE) {
      handleCancel();
    }
  };

  return (
    <>
      <button className="gateway-button" onClick={handleOpen}>
        Bee
      </button>

      {isOpen && (
        <div className="gateway-modal-backdrop" onClick={handleCancel}>
          <div className="gateway-modal" onClick={(e) => e.stopPropagation()}>
            <h3 className="gateway-modal-title">Bee URL</h3>
            <p className="gateway-modal-description">Enter your Bee node base URL</p>
            <input
              ref={inputRef}
              className="gateway-modal-input"
              type="text"
              value={inputValue}
              onChange={(e) => setInputValue(e.target.value)}
              onKeyDown={handleKeyDown}
              placeholder="http://localhost:1633"
            />
            <div className="gateway-modal-actions">
              <button className="gateway-modal-cancel" onClick={handleCancel}>
                Cancel
              </button>
              <button className="gateway-modal-confirm" onClick={handleConfirm}>
                Confirm
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
