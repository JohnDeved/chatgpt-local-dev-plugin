import type { UiResource } from "./common.js";

export const QUESTION_WIDGET_URI = "ui://widget/local-dev-question-v1.html";

const HTML = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <style>
    :root { color-scheme: light dark; font-family: ui-sans-serif,system-ui,-apple-system,sans-serif; }
    * { box-sizing: border-box; }
    body { margin: 0; padding: 10px; background: transparent; color: CanvasText; }
    form { display: grid; gap: 13px; }
    .intro h1 { margin: 0; font-size: 16px; line-height: 1.3; }
    .intro p { margin: 5px 0 0; color: color-mix(in srgb,currentColor 65%,transparent); font-size: 12px; line-height: 1.45; }
    fieldset { min-width: 0; margin: 0; padding: 11px; border: 1px solid color-mix(in srgb,currentColor 15%,transparent); border-radius: 12px; }
    legend { padding: 0 6px; color: color-mix(in srgb,currentColor 62%,transparent); font: 750 10px/1 ui-monospace,SFMono-Regular,monospace; letter-spacing: .07em; text-transform: uppercase; }
    .prompt { margin: 0 0 9px; font-size: 13px; font-weight: 650; line-height: 1.4; }
    .options { display: grid; gap: 7px; }
    .option { position: relative; display: grid; grid-template-columns: auto minmax(0,1fr); gap: 8px; align-items: start; padding: 9px; border: 1px solid color-mix(in srgb,currentColor 13%,transparent); border-radius: 9px; cursor: pointer; }
    .option:has(input:checked) { border-color: color-mix(in srgb,#3977d4 62%,transparent); background: color-mix(in srgb,#3977d4 8%,transparent); }
    .option input { margin: 2px 0 0; }
    .label { display: block; font-size: 12px; font-weight: 650; }
    .description { display: block; margin-top: 2px; color: color-mix(in srgb,currentColor 60%,transparent); font-size: 11px; line-height: 1.35; }
    .custom { display: grid; gap: 5px; margin-top: 8px; }
    .custom label { color: color-mix(in srgb,currentColor 66%,transparent); font-size: 11px; font-weight: 650; }
    textarea { width: 100%; min-height: 64px; resize: vertical; padding: 8px 9px; border: 1px solid color-mix(in srgb,currentColor 16%,transparent); border-radius: 9px; background: color-mix(in srgb,Canvas 96%,currentColor 4%); color: inherit; font: 12px/1.4 inherit; }
    .error { margin: 8px 0 0; color: #b42318; font-size: 11px; }
    .footer { display: flex; align-items: center; justify-content: space-between; gap: 10px; }
    .hint { margin: 0; color: color-mix(in srgb,currentColor 58%,transparent); font-size: 10px; }
    button { appearance: none; border: 0; border-radius: 9px; padding: 8px 13px; background: CanvasText; color: Canvas; font: 700 12px/1.2 inherit; cursor: pointer; }
    button:disabled { cursor: default; opacity: .55; }
    .submitted { padding: 14px; border: 1px solid color-mix(in srgb,#168653 35%,transparent); border-radius: 11px; background: color-mix(in srgb,#168653 8%,transparent); }
    .submitted h2 { margin: 0; color: #147a48; font-size: 14px; }
    .submitted p { margin: 5px 0 0; color: color-mix(in srgb,currentColor 65%,transparent); font-size: 12px; }
  </style>
</head>
<body>
  <main id="root"></main>
  <script>
    const root = document.getElementById("root");
    let request = null;
    let answers = {};
    let submitted = false;

    function node(tag, text, className) {
      const value = document.createElement(tag);
      if (text !== undefined) value.textContent = text;
      if (className) value.className = className;
      return value;
    }

    function envelope(result) { return result?.structuredContent ?? result; }

    function persist() {
      window.openai?.setWidgetState?.({ requestId: request?.requestId, answers, submitted });
    }

    function answerFor(id) {
      if (!answers[id]) answers[id] = { selected: [], custom: "" };
      return answers[id];
    }

    function renderSubmitted() {
      root.replaceChildren();
      const card = node("section", undefined, "submitted");
      card.append(node("h2", "Answers submitted"), node("p", "The conversation now contains your selections and the agent can continue."));
      root.append(card);
    }

    function render() {
      if (!request) { root.replaceChildren(node("p", "Waiting for questions…")); return; }
      if (submitted) { renderSubmitted(); return; }
      root.replaceChildren();
      const form = document.createElement("form");
      const intro = node("section", undefined, "intro");
      intro.append(node("h1", request.title || "A few questions"));
      if (request.intro) intro.append(node("p", request.intro));
      form.append(intro);

      for (const question of request.questions) {
        const fieldset = document.createElement("fieldset");
        fieldset.dataset.questionId = question.id;
        fieldset.append(node("legend", question.header || "Question"), node("p", question.question, "prompt"));
        const options = node("div", undefined, "options");
        const answer = answerFor(question.id);
        const type = question.multiSelect ? "checkbox" : "radio";
        for (const option of question.options) {
          const label = node("label", undefined, "option");
          const input = document.createElement("input");
          input.type = type;
          input.name = "question-" + question.id;
          input.value = option.id;
          input.checked = answer.selected.includes(option.id);
          input.addEventListener("change", () => {
            if (question.multiSelect) {
              answer.selected = [...fieldset.querySelectorAll('input[type="checkbox"]:checked')].map((item) => item.value);
            } else {
              answer.selected = [option.id];
              answer.custom = "";
              const custom = fieldset.querySelector("textarea");
              if (custom) custom.value = "";
            }
            fieldset.querySelector(".error")?.remove();
            persist();
          });
          const copy = node("span");
          copy.append(node("span", option.label, "label"));
          if (option.description) copy.append(node("span", option.description, "description"));
          label.append(input, copy);
          options.append(label);
        }
        fieldset.append(options);

        if (question.allowCustom !== false) {
          const custom = node("div", undefined, "custom");
          const textareaId = "custom-" + question.id;
          const customLabel = node("label", question.multiSelect ? "Custom answer (optional alongside selections)" : "Custom answer");
          customLabel.htmlFor = textareaId;
          const textarea = document.createElement("textarea");
          textarea.id = textareaId;
          textarea.placeholder = "Type another answer…";
          textarea.maxLength = 2000;
          textarea.value = answer.custom || "";
          textarea.addEventListener("input", () => {
            answer.custom = textarea.value;
            if (!question.multiSelect && textarea.value.trim()) {
              answer.selected = [];
              for (const input of fieldset.querySelectorAll('input[type="radio"]')) input.checked = false;
            }
            fieldset.querySelector(".error")?.remove();
            persist();
          });
          custom.append(customLabel, textarea);
          fieldset.append(custom);
        }
        form.append(fieldset);
      }

      const footer = node("section", undefined, "footer");
      footer.append(node("p", "Choose the closest option or write your own answer.", "hint"));
      const submit = node("button", "Submit answers");
      submit.type = "submit";
      footer.append(submit);
      form.append(footer);
      form.addEventListener("submit", submitAnswers);
      root.append(form);
    }

    function collect() {
      let valid = true;
      const result = [];
      for (const question of request.questions) {
        const fieldset = root.querySelector('[data-question-id="' + CSS.escape(question.id) + '"]');
        fieldset?.querySelector(".error")?.remove();
        const answer = answerFor(question.id);
        const custom = (answer.custom || "").trim();
        if (question.required !== false && answer.selected.length === 0 && !custom) {
          fieldset?.append(node("p", "Please select an option or enter a custom answer.", "error"));
          valid = false;
        }
        const selected = answer.selected.map((id) => {
          const option = question.options.find((candidate) => candidate.id === id);
          return option ? { id: option.id, label: option.label } : { id, label: id };
        });
        result.push({ id: question.id, question: question.question, selected, ...(custom ? { custom } : {}) });
      }
      return valid ? result : null;
    }

    function followUpText(collected) {
      const lines = collected.map((answer) => {
        const choices = answer.selected.map((choice) => choice.label);
        if (answer.custom) choices.push(answer.custom);
        return "- " + answer.question + ": " + (choices.length ? choices.join(", ") : "No answer");
      });
      return [
        "Here are my answers to your questions:",
        ...lines,
        "",
        "Structured answers:",
        JSON.stringify({ requestId: request.requestId, answers: collected }, null, 2),
        "",
        "Continue using these answers.",
      ].join("\\n");
    }

    async function submitAnswers(event) {
      event.preventDefault();
      const collected = collect();
      if (!collected) return;
      const button = event.submitter;
      if (button) button.disabled = true;
      const prompt = followUpText(collected);
      try {
        if (window.openai?.sendFollowUpMessage) await window.openai.sendFollowUpMessage({ prompt, scrollToBottom: true });
        else window.parent.postMessage({ jsonrpc: "2.0", method: "ui/message", params: { role: "user", content: [{ type: "text", text: prompt }] } }, "*");
        submitted = true;
        persist();
        renderSubmitted();
      } catch (error) {
        if (button) button.disabled = false;
        const message = error instanceof Error ? error.message : "Could not submit answers.";
        event.currentTarget.append(node("p", message, "error"));
      }
    }

    function update(result) {
      const value = envelope(result);
      if (!value || value.ok === false || !Array.isArray(value.data?.questions)) return;
      request = value.data;
      const state = window.openai?.widgetState;
      if (state?.requestId === request.requestId) {
        answers = state.answers || {};
        submitted = state.submitted === true;
      } else {
        answers = {};
        submitted = false;
      }
      render();
    }

    window.addEventListener("message", (event) => {
      if (event.source !== window.parent) return;
      const message = event.data;
      if (message?.jsonrpc === "2.0" && message.method === "ui/notifications/tool-result") update(message.params);
    }, { passive: true });
    window.addEventListener("openai:set_globals", (event) => update(event.detail?.globals?.toolOutput), { passive: true });
    update(window.openai?.toolOutput);
  </script>
</body>
</html>`;

export const questionWidget: UiResource = {
  name: "Local Dev question form",
  uri: QUESTION_WIDGET_URI,
  description: "Presents several concise agent questions together, with single- or multi-choice answers and optional custom responses.",
  html: HTML,
  prefersBorder: true,
};
