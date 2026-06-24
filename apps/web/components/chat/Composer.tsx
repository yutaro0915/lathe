"use client";

import * as React from "react";
import { Button, IconButton, SearchInput } from "@/design-system/components";
import { Icon } from "@/design-system/components/icons";
import type { ChatContextAttachment } from "@/lib/chat";
import { t } from "@/lib/i18n";

export interface ComposerProps {
  contexts: ChatContextAttachment[];
  disabled?: boolean;
  onContextsChange: (contexts: ChatContextAttachment[]) => void;
  onSend: (body: string) => Promise<void> | void;
}

function textLabel(value: string): string {
  const clean = value.replace(/\s+/g, " ").trim();
  return clean.length > 46 ? `${clean.slice(0, 43)}...` : clean;
}

export default function Composer({ contexts, disabled = false, onContextsChange, onSend }: ComposerProps) {
  const [body, setBody] = React.useState("");
  const [adding, setAdding] = React.useState(false);
  const [contextText, setContextText] = React.useState("");

  const removeContext = (id: string) => {
    onContextsChange(contexts.filter((context) => context.id !== id));
  };
  const addTextContext = () => {
    const value = contextText.trim();
    if (!value) {
      setAdding(false);
      return;
    }
    onContextsChange([
      ...contexts,
      { id: `text:${Date.now()}`, kind: "text", label: `${t("chat.composer.context.textPrefix")}: ${textLabel(value)}`, value },
    ]);
    setContextText("");
    setAdding(false);
  };

  const submit = async () => {
    const value = body.trim();
    if (!value || disabled) return;
    setBody("");
    await onSend(value);
  };

  return (
    <form
      className="chat-composer"
      data-testid="composer"
      onSubmit={(event) => {
        event.preventDefault();
        void submit();
      }}
    >
      <div className="chat-composer-context" data-testid="composer-context" aria-label={t("chat.composer.context.attachedLabel")}>
        {contexts.map((context) => (
          <span className="chat-context-chip" data-context-kind={context.kind} key={context.id}>
            <span className="chat-context-main">
              <span className="chat-context-label">{context.label}</span>
              {context.detail ? <span className="chat-context-detail">{context.detail}</span> : null}
            </span>
            <IconButton label={`${context.label}${t("chat.composer.context.removeSuffix")}`} className="chat-context-remove" onClick={() => removeContext(context.id)}>
              <Icon name="x" size={13} />
            </IconButton>
          </span>
        ))}
        {adding ? (
          <span className="chat-context-add">
            <span style={{ flex: "1 1 auto", minWidth: 0 }}>
              <SearchInput
                icon={null}
                className="chat-context-add"
                value={contextText}
                onChange={(event) => setContextText(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter") {
                    event.preventDefault();
                    addTextContext();
                  }
                }}
                placeholder={t("chat.composer.context.freeForm")}
                aria-label={t("chat.composer.context.freeForm")}
              />
            </span>
            <Button size="sm" onClick={addTextContext}>{t("chat.composer.context.attach")}</Button>
          </span>
        ) : null}
        <Button
          size="sm"
          variant="ghost"
          icon={<Icon name="plus" size={13} />}
          data-testid="composer-add-context"
          onClick={() => setAdding((open) => !open)}
        >
          {t("chat.composer.addContext")}
        </Button>
      </div>
      <div className="chat-composer-inputrow">
        <textarea
          data-testid="composer-input"
          value={body}
          disabled={disabled}
          placeholder={t("chat.composer.placeholder")}
          rows={2}
          onChange={(event) => setBody(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && !event.shiftKey) {
              event.preventDefault();
              void submit();
            }
          }}
        />
        <IconButton label={t("chat.composer.send")} data-testid="composer-send" className="chat-send" disabled={disabled || !body.trim()} onClick={() => void submit()}>
          <Icon name="send" size={15} />
        </IconButton>
      </div>
    </form>
  );
}
