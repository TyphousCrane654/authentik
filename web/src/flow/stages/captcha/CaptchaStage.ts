/// <reference types="@hcaptcha/types"/>
/// <reference types="turnstile-types"/>
import { renderStaticHTMLUnsafe } from "@goauthentik/common/purify";
import { akEmptyState } from "@goauthentik/elements/EmptyState";
import { bound } from "@goauthentik/elements/decorators/bound";
import "@goauthentik/elements/forms/FormElement";
import { createIFrameHTMLWrapper } from "@goauthentik/elements/utils/iframe";
import { ListenerController } from "@goauthentik/elements/utils/listenerController.js";
import { randomId } from "@goauthentik/elements/utils/randomId";
import "@goauthentik/flow/FormStatic";
import "@goauthentik/flow/components/ak-flow-card.js";
import { BaseStage } from "@goauthentik/flow/stages/base";
import { P, match } from "ts-pattern";

import { msg } from "@lit/localize";
import { CSSResult, PropertyValues, TemplateResult, css, html, nothing } from "lit";
import { customElement, property, state } from "lit/decorators.js";
import { ifDefined } from "lit/directives/if-defined.js";

import PFForm from "@patternfly/patternfly/components/Form/form.css";
import PFFormControl from "@patternfly/patternfly/components/FormControl/form-control.css";
import PFLogin from "@patternfly/patternfly/components/Login/login.css";
import PFTitle from "@patternfly/patternfly/components/Title/title.css";
import PFBase from "@patternfly/patternfly/patternfly-base.css";

import { CaptchaChallenge, CaptchaChallengeResponseRequest } from "@goauthentik/api";

type TokenHandler = (token: string) => void;

type Dims = { height: number };

type IframeCaptchaMessage = {
    source?: string;
    context?: string;
    message: "captcha";
    token: string;
};

type IframeResizeMessage = {
    source?: string;
    context?: string;
    message: "resize";
    size: Dims;
};

type IframeMessageEvent = MessageEvent<IframeCaptchaMessage | IframeResizeMessage>;

type CaptchaHandler = {
    name: string;
    interactive: () => Promise<unknown>;
    execute: () => Promise<unknown>;
    refreshInteractive: () => Promise<unknown>;
    refresh: () => Promise<unknown>;
};

// A container iframe for a hosted Captcha, with an event emitter to monitor when the Captcha forces
// a resize. Because the Captcha is itself in an iframe, the reported height is often off by some
// margin, so adding 2rem of height to our container adds padding and prevents scroll bars or hidden
// rendering.
function iframeTemplate(children: TemplateResult, challengeURL: string): TemplateResult {
    return html` ${children}
        <script>
            new ResizeObserver((entries) => {
                const height =
                    document.body.offsetHeight +
                    parseFloat(getComputedStyle(document.body).fontSize) * 2;

                window.parent.postMessage({
                    message: "resize",
                    source: "goauthentik.io",
                    context: "flow-executor",
                    size: { height },
                });
            }).observe(document.querySelector(".ak-captcha-container"));
        </script>

        <script src=${challengeURL}></script>

        <script>
            function callback(token) {
                window.parent.postMessage({
                    message: "captcha",
                    source: "goauthentik.io",
                    context: "flow-executor",
                    token,
                });
            }
        </script>`;
}

@customElement("ak-stage-captcha")
export class CaptchaStage extends BaseStage<CaptchaChallenge, CaptchaChallengeResponseRequest> {
    static get styles(): CSSResult[] {
        return [
            PFBase,
            PFLogin,
            PFForm,
            PFFormControl,
            PFTitle,
            css`
                iframe {
                    width: 100%;
                    height: 0;
                }
            `,
        ];
    }

    @property({ type: Boolean })
    embedded = false;

    @property()
    onTokenChange: TokenHandler = (token: string) => {
        this.host.submit({ component: "ak-stage-captcha", token });
    };

    @property({ attribute: false })
    refreshedAt = new Date();

    @state()
    activeHandler?: CaptchaHandler = undefined;

    @state()
    error?: string;

    handlers: CaptchaHandler[] = [
        {
            name: "grecaptcha",
            interactive: this.renderGReCaptchaFrame,
            execute: this.executeGReCaptcha,
            refreshInteractive: this.refreshGReCaptchaFrame,
            refresh: this.refreshGReCaptcha,
        },
        {
            name: "hcaptcha",
            interactive: this.renderHCaptchaFrame,
            execute: this.executeHCaptcha,
            refreshInteractive: this.refreshHCaptchaFrame,
            refresh: this.refreshHCaptcha,
        },
        {
            name: "turnstile",
            interactive: this.renderTurnstileFrame,
            execute: this.executeTurnstile,
            refreshInteractive: this.refreshTurnstileFrame,
            refresh: this.refreshTurnstile,
        },
    ];

    _captchaFrame?: HTMLIFrameElement;
    _captchaDocumentContainer?: HTMLDivElement;
    _listenController = new ListenerController();

    connectedCallback(): void {
        super.connectedCallback();
        window.addEventListener("message", this.onIframeMessage, {
            signal: this._listenController.signal,
        });
    }

    disconnectedCallback(): void {
        this._listenController.abort();
        if (!this.challenge?.interactive) {
            if (document.body.contains(this.captchaDocumentContainer)) {
                document.body.removeChild(this.captchaDocumentContainer);
            }
        }
        super.disconnectedCallback();
    }

    get captchaDocumentContainer(): HTMLDivElement {
        if (this._captchaDocumentContainer) {
            return this._captchaDocumentContainer;
        }
        this._captchaDocumentContainer = document.createElement("div");
        this._captchaDocumentContainer.id = `ak-captcha-${randomId()}`;
        return this._captchaDocumentContainer;
    }

    get captchaFrame(): HTMLIFrameElement {
        if (this._captchaFrame) {
            return this._captchaFrame;
        }
        this._captchaFrame = document.createElement("iframe");
        this._captchaFrame.src = "about:blank";
        this._captchaFrame.id = `ak-captcha-${randomId()}`;
        return this._captchaFrame;
    }

    onFrameResize({ height }: Dims) {
        this.captchaFrame.style.height = `${height}px`;
    }

    // ADR: Did not to put anything into `otherwise` or `exhaustive` here because iframe messages
    // that were not of interest to us also weren't necessarily corrupt or suspicious. For example,
    // during testing Storybook throws a lot of cross-iframe messages that we don't care about.

    @bound
    onIframeMessage({ data }: IframeMessageEvent) {
        match(data)
            .with(
                { source: "goauthentik.io", context: "flow-executor", message: "captcha" },
                ({ token }) => this.onTokenChange(token),
            )
            .with(
                { source: "goauthentik.io", context: "flow-executor", message: "resize" },
                ({ size }) => this.onFrameResize(size),
            )
            .with(
                { source: "goauthentik.io", context: "flow-executor", message: P.any },
                ({ message }) => {
                    console.debug(`authentik/stages/captcha: Unknown message: ${message}`);
                },
            )
            .otherwise(() => {});
    }

    async renderGReCaptchaFrame() {
        this.renderFrame(
            html`<div
                class="g-recaptcha ak-captcha-container"
                data-sitekey="${this.challenge.siteKey}"
                data-callback="callback"
            ></div>`,
        );
    }

    async executeGReCaptcha() {
        return grecaptcha.ready(() => {
            grecaptcha.execute(
                grecaptcha.render(this.captchaDocumentContainer, {
                    sitekey: this.challenge.siteKey,
                    callback: this.onTokenChange,
                    size: "invisible",
                }),
            );
        });
    }

    async refreshGReCaptchaFrame() {
        (this.captchaFrame.contentWindow as typeof window)?.grecaptcha.reset();
    }

    async refreshGReCaptcha() {
        window.grecaptcha.reset();
        window.grecaptcha.execute();
    }

    async renderHCaptchaFrame() {
        this.renderFrame(
            html`<div
                class="h-captcha ak-captcha-container"
                data-sitekey="${this.challenge.siteKey}"
                data-theme="${this.activeTheme ? this.activeTheme : "light"}"
                data-callback="callback"
            ></div> `,
        );
    }

    async executeHCaptcha() {
        return hcaptcha.execute(
            hcaptcha.render(this.captchaDocumentContainer, {
                sitekey: this.challenge.siteKey,
                callback: this.onTokenChange,
                size: "invisible",
            }),
        );
    }

    async refreshHCaptchaFrame() {
        (this.captchaFrame.contentWindow as typeof window)?.hcaptcha.reset();
    }

    async refreshHCaptcha() {
        window.hcaptcha.reset();
        window.hcaptcha.execute();
    }

    async renderTurnstileFrame() {
        this.renderFrame(
            html`<div
                class="cf-turnstile ak-captcha-container"
                data-sitekey="${this.challenge.siteKey}"
                data-callback="callback"
            ></div>`,
        );
    }

    async executeTurnstile() {
        return window.turnstile.render(this.captchaDocumentContainer, {
            sitekey: this.challenge.siteKey,
            callback: this.onTokenChange,
        });
    }

    async refreshTurnstileFrame() {
        (this.captchaFrame.contentWindow as typeof window)?.turnstile.reset();
    }

    async refreshTurnstile() {
        window.turnstile.reset();
    }

    async renderFrame(captchaElement: TemplateResult) {
        const { contentDocument } = this.captchaFrame || {};

        if (!contentDocument) {
            console.debug(
                "authentik/stages/captcha: unable to render captcha frame, no contentDocument",
            );

            return;
        }

        contentDocument.open();

        contentDocument.write(
            createIFrameHTMLWrapper(
                renderStaticHTMLUnsafe(iframeTemplate(captchaElement, this.challenge.jsUrl)),
            ),
        );

        contentDocument.close();
    }

    renderBody() {
        // [hasError, isInteractive]
        // prettier-ignore
        return match([Boolean(this.error), Boolean(this.challenge?.interactive)])
            .with([true,  P.any], () => akEmptyState({ icon: "fa-times" }, { heading: this.error }))
            .with([false, true],  () => html`${this.captchaFrame}`)
            .with([false, false], () => akEmptyState({ loading: true }, { heading: msg("Verifying...") }))
            .exhaustive();
    }

    renderMain() {
        return html`<ak-flow-card .challenge=${this.challenge}>
            <form class="pf-c-form">
                <ak-form-static
                    class="pf-c-form__group"
                    userAvatar="${this.challenge.pendingUserAvatar}"
                    user=${this.challenge.pendingUser}
                >
                    <div slot="link">
                        <a href="${ifDefined(this.challenge.flowInfo?.cancelUrl)}"
                            >${msg("Not you?")}</a
                        >
                    </div>
                </ak-form-static>
                ${this.renderBody()}
            </form>
        </ak-flow-card>`;
    }

    render() {
        if (!this.challenge) {
            return this.embedded ? nothing : akEmptyState({ loading: true });
        }

        if (!this.embedded) {
            return this.renderMain();
        }

        return this.challenge.interactive ? this.renderBody() : nothing;
    }

    //#endregion;

    //#region Lifecycle

    public connectedCallback(): void {
        super.connectedCallback();
        window.addEventListener("message", this.#messageListener, {
            signal: this.#listenController.signal,
        });
    }

    public disconnectedCallback(): void {
        this.#listenController.abort();

        if (!this.challenge?.interactive) {
            if (document.body.contains(this.captchaDocumentContainer)) {
                document.body.removeChild(this.captchaDocumentContainer);
            }
        }

        super.disconnectedCallback();
    }

    //#endregion

    public firstUpdated(changedProperties: PropertyValues<this>) {
        if (!(changedProperties.has("challenge") && typeof this.challenge !== "undefined")) {
            return;
        }

        const loadListener = async () => {
            console.debug("authentik/stages/captcha: script loaded");

            let lastError: unknown;
            let found = false;

            for (const [name, handler] of this.#handlers) {
                if (!Object.hasOwn(window, name)) {
                    continue;
                }

                console.debug(`authentik/stages/captcha: trying handler ${name}`);

                const runner = this.challenge.interactive ? handler.interactive : handler.execute;

                try {
                    await runner.apply(this);

                    console.debug(`authentik/stages/captcha[${name}]: handler succeeded`);

                    found = true;
                    this.activeHandler = handler;

                    break;
                } catch (error) {
                    console.debug(`authentik/stages/captcha[${name}]: handler failed`);
                    console.debug(error);

                    lastError = error;
                }
            }

            this.error = found ? null : pluckErrorDetail(lastError, "Unspecified error");
        };

        const scriptElement = document.createElement("script");

        scriptElement.src = this.challenge.jsUrl;
        scriptElement.async = true;
        scriptElement.defer = true;
        scriptElement.onload = loadListener;

        this.#scriptElement?.remove();

        this.#scriptElement = document.head.appendChild(scriptElement);

        if (!this.challenge.interactive) {
            document.body.appendChild(this.captchaDocumentContainer);
        }
    }

    public updated(changedProperties: PropertyValues<this>) {
        if (!changedProperties.has("refreshedAt") || !this.challenge) {
            return;
        }

        console.debug("authentik/stages/captcha: refresh triggered");

        const handler = this.challenge.interactive
            ? this.activeHandler?.refreshInteractive
            : this.activeHandler?.refresh;

        handler?.apply(this);
    }
}

declare global {
    interface HTMLElementTagNameMap {
        "ak-stage-captcha": CaptchaStage;
    }
}
