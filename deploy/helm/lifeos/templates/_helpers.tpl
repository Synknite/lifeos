{{/* Common names and labels. */}}
{{- define "lifeos.fullname" -}}
{{- if contains .Chart.Name .Release.Name -}}
{{- .Release.Name | trunc 63 | trimSuffix "-" -}}
{{- else -}}
{{- printf "%s-%s" .Release.Name .Chart.Name | trunc 63 | trimSuffix "-" -}}
{{- end -}}
{{- end -}}

{{- define "lifeos.labels" -}}
helm.sh/chart: {{ printf "%s-%s" .Chart.Name .Chart.Version }}
app.kubernetes.io/name: {{ .Chart.Name }}
app.kubernetes.io/instance: {{ .Release.Name }}
app.kubernetes.io/version: {{ .Chart.AppVersion | quote }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
app.kubernetes.io/part-of: lifeos
{{- end -}}

{{/* Selector labels for one component: call with (dict "ctx" . "component" "api"). */}}
{{- define "lifeos.selector" -}}
app.kubernetes.io/name: {{ .ctx.Chart.Name }}
app.kubernetes.io/instance: {{ .ctx.Release.Name }}
app.kubernetes.io/component: {{ .component }}
{{- end -}}

{{- define "lifeos.image" -}}
{{- printf "%s/lifeos-%s:%s" .ctx.Values.imageRegistry .component (default .ctx.Chart.AppVersion .ctx.Values.imageTag) -}}
{{- end -}}

{{- define "lifeos.secretName" -}}
{{- default (printf "%s-secrets" (include "lifeos.fullname" .)) .Values.existingSecret -}}
{{- end -}}

{{/* Hardened container defaults: non-root, read-only root FS, no capabilities. */}}
{{- define "lifeos.containerSecurity" -}}
securityContext:
  allowPrivilegeEscalation: false
  readOnlyRootFilesystem: true
  capabilities:
    drop: [ALL]
{{- end -}}

{{/* Environment shared by api and worker. */}}
{{- define "lifeos.env" -}}
envFrom:
  - configMapRef:
      name: {{ include "lifeos.fullname" . }}-config
  - secretRef:
      name: {{ include "lifeos.secretName" . }}
env:
  - name: SERVICE_VERSION
    value: {{ default .Chart.AppVersion .Values.imageTag | quote }}
  - name: OTEL_RESOURCE_ATTRIBUTES
    value: "deployment.environment={{ .Release.Namespace }},k8s.namespace.name={{ .Release.Namespace }}"
  - name: K8S_POD_NAME
    valueFrom: { fieldRef: { fieldPath: metadata.name } }
{{- end -}}

{{- define "lifeos.spread" -}}
topologySpreadConstraints:
  - maxSkew: 1
    topologyKey: kubernetes.io/hostname
    whenUnsatisfiable: ScheduleAnyway
    labelSelector:
      matchLabels:
        {{- include "lifeos.selector" . | nindent 8 }}
{{- end -}}
