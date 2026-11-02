import { Show } from "solid-js"
import { ResultPanel } from "../components/ResultPanel"
import type { SetupInspect } from "../setup-client"

export interface GithubAuthStepProps {
  facts: SetupInspect
  working: boolean
  onRefreshIdentity: () => void
  onContinueClone: () => void
}

function sourceLabel(source: string | undefined): string {
  if (source === "gh") return "本机 gh 登录"
  if (source === "process-env") return "Shell 环境变量"
  if (source === "home-env" || source === "env") return "WOPAL_HOME Token"
  return source ?? "已验证凭证"
}

export function GithubAuthStep(props: GithubAuthStepProps) {
  const ready = () => props.facts.credentials.github.configured && props.facts.credentials.github.source === "gh"
  const alternateCredential = () => props.facts.credentials.github.configured && !ready()

  return (
    <div id="onboarding-step-github-auth" class="ob-step-content">
      <Show when={ready()}>
        <ResultPanel title="GitHub 身份已经可用">
          <div class="ob-result-details">
            <Show when={props.facts.credentials.github.account}>
              <div class="ob-result-row">
                <span class="ob-result-label">账号</span>
                <span class="ob-result-value">{props.facts.credentials.github.account}</span>
              </div>
            </Show>
            <div class="ob-result-row">
              <span class="ob-result-label">来源</span>
              <span class="ob-result-value">{sourceLabel(props.facts.credentials.github.source)}</span>
            </div>
          </div>
        </ResultPanel>
      </Show>

      <Show when={!ready()}>
        <Show when={alternateCredential()}>
          <ResultPanel title="检测到 GitHub 凭证，但本机 gh 尚未登录">
            <div class="ob-result-details">
              <Show when={props.facts.credentials.github.account}>
                <div class="ob-result-row">
                  <span class="ob-result-label">账号</span>
                  <span class="ob-result-value">{props.facts.credentials.github.account}</span>
                </div>
              </Show>
              <Show when={props.facts.credentials.github.source}>
                <div class="ob-result-row">
                  <span class="ob-result-label">凭证来源</span>
                  <span class="ob-result-value">{sourceLabel(props.facts.credentials.github.source)}</span>
                </div>
              </Show>
            </div>
          </ResultPanel>
        </Show>

        <div class="ob-ontology-section">
          <div class="ob-ontology-section-title">登录 GitHub 以使用 Fork</div>
          <p class="ob-field-help">
            请先安装或打开 GitHub CLI，在终端运行 <code>gh auth login</code> 完成本机登录，然后回到这里重新检测。
          </p>
          <button
            type="button"
            class="ob-button ob-button-secondary"
            disabled={props.working}
            onClick={props.onRefreshIdentity}
          >
            重新检测 GitHub 登录
          </button>
        </div>
        <button
          type="button"
          class="ob-button ob-button-secondary"
          disabled={props.working}
          onClick={props.onContinueClone}
        >
          放弃 Fork，使用 Clone
        </button>
      </Show>
    </div>
  )
}
