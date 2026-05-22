"use client";

import "./LanguageSelector.css";

interface LanguageSelectorProps {
  onSelect: (language: "zh" | "en") => void;
}

const GlobeIcon = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
    <circle cx="12" cy="12" r="10" />
    <line x1="2" y1="12" x2="22" y2="12" />
    <path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z" />
  </svg>
);

export default function LanguageSelector({ onSelect }: LanguageSelectorProps) {
  return (
    <div className="language-selector-overlay">
      <div className="language-selector-dialog">
        <div className="language-selector-header">
          <div className="language-selector-icon">
            <GlobeIcon />
          </div>
          <div className="language-selector-title">
            Select Language / 选择语言
          </div>
          <div className="language-selector-subtitle">
            Choose your preferred language
          </div>
        </div>
        <div className="language-selector-options">
          <button
            className="language-selector-option"
            onClick={() => onSelect("zh")}
          >
            <span className="language-selector-flag">🇨🇳</span>
            <div className="language-selector-label">
              <span className="language-selector-label-primary">中文</span>
              <span className="language-selector-label-secondary">Chinese (Simplified)</span>
            </div>
          </button>
          <button
            className="language-selector-option"
            onClick={() => onSelect("en")}
          >
            <span className="language-selector-flag">🇺🇸</span>
            <div className="language-selector-label">
              <span className="language-selector-label-primary">English</span>
              <span className="language-selector-label-secondary">英语</span>
            </div>
          </button>
        </div>
      </div>
    </div>
  );
}
