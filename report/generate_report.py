#!/usr/bin/env python3
"""
VTC ONE — Générateur de rapport de performance hebdomadaire
============================================================
Compare les métriques de la version courante vs la version précédente
en production, identifie les 3 zones H3 avec le plus grand écart de
score composite, et génère un rapport Markdown prêt à être posté
en GitHub Issue.

Usage :
    python generate_report.py \
        --metrics-file metrics/vtc_one_metrics.json \
        --repo bamhamza86-wq/vtc-intelligence \
        --post-issue

Sorties :
    - Rapport Markdown sur stdout
    - Fichier /tmp/vtc_one_report.md
    - GitHub Issue créé si --post-issue
"""

from __future__ import annotations

import argparse
import json
import os
import subprocess
import sys
from datetime import datetime, timezone
from typing import Optional


# ─────────────────────────────────────────────────────────────────────────────
# Seuils d'alerte (configurable via env)
# ─────────────────────────────────────────────────────────────────────────────

SEUIL_REGRESSION_MAPE_PCT       = float(os.getenv("SEUIL_REGRESSION_MAPE",       "2.0"))   # +2 pts MAPE
SEUIL_REGRESSION_PRECISION_PCT  = float(os.getenv("SEUIL_REGRESSION_PRECISION",  "3.0"))   # -3 pts précision
SEUIL_REGRESSION_LATENCE_MS     = float(os.getenv("SEUIL_REGRESSION_LATENCE",    "5.0"))   # +5 ms P95
SEUIL_REGRESSION_RENTABILITE    = float(os.getenv("SEUIL_REGRESSION_RENTABILITE","2.0"))   # -2 €/h
SEUIL_ECART_ZONE_SCORE          = float(os.getenv("SEUIL_ECART_ZONE",            "0.03"))  # delta score ≥ 0.03


# ─────────────────────────────────────────────────────────────────────────────
# Chargement et validation des métriques
# ─────────────────────────────────────────────────────────────────────────────

def load_metrics(path: str) -> dict:
    """Charge le fichier de métriques JSON depuis le repo GitHub ou le disque."""
    if not os.path.exists(path):
        raise FileNotFoundError(
            f"Fichier de métriques introuvable : {path}\n"
            "Assurez-vous que metrics/vtc_one_metrics.json est commité dans le repo."
        )
    with open(path, encoding="utf-8") as f:
        data = json.load(f)
    versions = data.get("versions", [])
    if len(versions) < 2:
        raise ValueError(
            f"Le fichier de métriques contient {len(versions)} version(s). "
            "Minimum 2 requis pour générer une comparaison."
        )
    return data


def get_last_two_versions(data: dict) -> tuple[dict, dict]:
    """Retourne (version_précédente, version_courante) triées par deployed_at."""
    versions = sorted(
        data["versions"],
        key=lambda v: v["deployed_at"]
    )
    return versions[-2], versions[-1]


# ─────────────────────────────────────────────────────────────────────────────
# Analyse des métriques globales
# ─────────────────────────────────────────────────────────────────────────────

def delta(new: float, old: float, invert: bool = False) -> tuple[float, str]:
    """
    Calcule le delta absolu et la direction de changement.
    invert=True quand une baisse est une amélioration (ex: MAPE, latence).
    """
    d = new - old
    if invert:
        arrow = "🟢" if d < 0 else ("🔴" if d > 0 else "⚪")
    else:
        arrow = "🟢" if d > 0 else ("🔴" if d < 0 else "⚪")
    sign = "+" if d >= 0 else ""
    return d, f"{sign}{d:.3f}", arrow


def detect_global_regressions(prev: dict, curr: dict) -> list[str]:
    """Identifie les régressions sur les métriques globales."""
    regressions = []
    gp = prev["global_metrics"]
    gc = curr["global_metrics"]

    if gc["mape_duree_trajet_pct"] - gp["mape_duree_trajet_pct"] > SEUIL_REGRESSION_MAPE_PCT:
        regressions.append(
            f"MAPE durée trajet : {gp['mape_duree_trajet_pct']:.1f}% → {gc['mape_duree_trajet_pct']:.1f}% "
            f"(+{gc['mape_duree_trajet_pct'] - gp['mape_duree_trajet_pct']:.1f} pts)"
        )
    if gc["mape_demande_20min_pct"] - gp["mape_demande_20min_pct"] > SEUIL_REGRESSION_MAPE_PCT:
        regressions.append(
            f"MAPE demande 20min : {gp['mape_demande_20min_pct']:.1f}% → {gc['mape_demande_20min_pct']:.1f}%"
        )
    if gp["precision_top1_zone_pct"] - gc["precision_top1_zone_pct"] > SEUIL_REGRESSION_PRECISION_PCT:
        regressions.append(
            f"Précision top-1 zone : {gp['precision_top1_zone_pct']:.1f}% → {gc['precision_top1_zone_pct']:.1f}%"
        )
    if gc["latence_cycle_p95_ms"] - gp["latence_cycle_p95_ms"] > SEUIL_REGRESSION_LATENCE_MS:
        regressions.append(
            f"Latence cycle P95 : {gp['latence_cycle_p95_ms']:.1f}ms → {gc['latence_cycle_p95_ms']:.1f}ms"
        )
    if gp["rentabilite_realisee_eur_h"] - gc["rentabilite_realisee_eur_h"] > SEUIL_REGRESSION_RENTABILITE:
        regressions.append(
            f"Rentabilité réalisée : {gp['rentabilite_realisee_eur_h']:.1f}€/h → "
            f"{gc['rentabilite_realisee_eur_h']:.1f}€/h "
            f"(-{gp['rentabilite_realisee_eur_h'] - gc['rentabilite_realisee_eur_h']:.1f}€/h)"
        )
    return regressions


# ─────────────────────────────────────────────────────────────────────────────
# Analyse par zone H3
# ─────────────────────────────────────────────────────────────────────────────

def analyze_zone_deltas(prev: dict, curr: dict) -> list[dict]:
    """
    Calcule l'écart de score composite moyen pour chaque zone présente
    dans les deux versions. Retourne les zones triées par |delta| décroissant.
    """
    prev_zones = {z["zone_h3"]: z for z in prev.get("zones_h3", [])}
    curr_zones = {z["zone_h3"]: z for z in curr.get("zones_h3", [])}

    common = set(prev_zones.keys()) & set(curr_zones.keys())
    deltas = []

    for zone_h3 in common:
        zp = prev_zones[zone_h3]
        zc = curr_zones[zone_h3]

        d_score = zc["score_composite_moyen"] - zp["score_composite_moyen"]
        d_precision = zc["precision_recommandation_pct"] - zp["precision_recommandation_pct"]
        d_rentabilite = zc["rentabilite_nette_moy_eur_h"] - zp["rentabilite_nette_moy_eur_h"]

        deltas.append({
            "zone_h3": zone_h3,
            "label": zc.get("label", zone_h3),
            "score_prev": zp["score_composite_moyen"],
            "score_curr": zc["score_composite_moyen"],
            "delta_score": d_score,
            "abs_delta_score": abs(d_score),
            "delta_precision_pct": d_precision,
            "delta_rentabilite_eur_h": d_rentabilite,
            "nb_eval_prev": zp.get("nb_evaluations", 0),
            "nb_eval_curr": zc.get("nb_evaluations", 0),
            "std_prev": zp.get("score_composite_std", 0),
            "std_curr": zc.get("score_composite_std", 0),
            "is_regression": d_score < -SEUIL_ECART_ZONE_SCORE,
            "is_improvement": d_score > SEUIL_ECART_ZONE_SCORE,
        })

    deltas.sort(key=lambda x: x["abs_delta_score"], reverse=True)
    return deltas


def fmt_delta_score(d: float) -> str:
    sign = "+" if d >= 0 else ""
    emoji = "🟢" if d > SEUIL_ECART_ZONE_SCORE else ("🔴" if d < -SEUIL_ECART_ZONE_SCORE else "⚪")
    return f"{emoji} `{sign}{d:.4f}`"


def fmt_delta_generic(d: float, unit: str = "", invert: bool = False) -> str:
    sign = "+" if d >= 0 else ""
    if invert:
        emoji = "🟢" if d < 0 else ("🔴" if d > 0 else "⚪")
    else:
        emoji = "🟢" if d > 0 else ("🔴" if d < 0 else "⚪")
    return f"{emoji} `{sign}{d:.2f}{unit}`"


# ─────────────────────────────────────────────────────────────────────────────
# Génération du rapport Markdown
# ─────────────────────────────────────────────────────────────────────────────

def generate_report(prev: dict, curr: dict, zone_deltas: list[dict]) -> str:
    now = datetime.now(timezone.utc)
    regressions = detect_global_regressions(prev, curr)
    top3_zones = zone_deltas[:3]
    gp = prev["global_metrics"]
    gc = curr["global_metrics"]

    # Statut global
    if regressions:
        status_badge = "🔴 RÉGRESSION DÉTECTÉE"
        status_color = "critical"
    else:
        all_zones_ok = all(not z["is_regression"] for z in top3_zones)
        if all_zones_ok:
            status_badge = "🟢 AUCUNE RÉGRESSION"
            status_color = "ok"
        else:
            status_badge = "🟡 RÉGRESSION ZONE(S)"
            status_color = "warning"

    lines = []
    lines.append(
        f"# 📊 VTC ONE — Rapport de Performance Hebdomadaire\n"
        f"**Généré le** : {now.strftime('%A %d %B %Y à %H:%M UTC')}  \n"
        f"**Statut global** : {status_badge}\n"
    )

    # ── Versions comparées ──
    lines.append("---\n## 🔄 Versions comparées\n")
    lines.append(
        f"| | Version précédente | Version courante |\n"
        f"|---|---|---|\n"
        f"| **Version** | `{prev['version']}` | `{curr['version']}` |\n"
        f"| **SHA Git** | `{prev.get('git_sha','—')}` | `{curr.get('git_sha','—')}` |\n"
        f"| **Déployée le** | `{prev['deployed_at'][:10]}` | `{curr['deployed_at'][:10]}` |\n"
        f"| **Fenêtre d'éval.** | `{prev.get('evaluation_window','—')}` | `{curr.get('evaluation_window','—')}` |\n"
    )

    # ── Métriques globales ──
    lines.append("\n---\n## 📈 Métriques globales\n")

    def row(label, key, unit="", invert=False, fmt=".2f"):
        vp = gp[key]
        vc = gc[key]
        d = vc - vp
        sign = "+" if d >= 0 else ""
        if invert:
            e = "🟢" if d < 0 else ("🔴" if d > 0 else "⚪")
        else:
            e = "🟢" if d > 0 else ("🔴" if d < 0 else "⚪")
        return (
            f"| {label} | `{vp:{fmt}}{unit}` | `{vc:{fmt}}{unit}` "
            f"| {e} `{sign}{d:{fmt}}{unit}` |\n"
        )

    lines.append(
        "| Métrique | v précédente | v courante | Delta |\n"
        "|----------|-------------|-----------|-------|\n"
    )
    lines.append(row("MAPE durée trajet",         "mape_duree_trajet_pct",       "%", invert=True))
    lines.append(row("MAPE demande 20min",         "mape_demande_20min_pct",       "%", invert=True))
    lines.append(row("MAE score composite",        "mae_score_composite",          "",  invert=True, fmt=".4f"))
    lines.append(row("Précision top-1 zone",       "precision_top1_zone_pct",      "%"))
    lines.append(row("Précision top-3 zones",      "precision_top3_zones_pct",     "%"))
    lines.append(row("Latence P50 cycle",          "latence_cycle_p50_ms",         "ms", invert=True))
    lines.append(row("Latence P95 cycle",          "latence_cycle_p95_ms",         "ms", invert=True))
    lines.append(row("Latence P99 cycle",          "latence_cycle_p99_ms",         "ms", invert=True))
    lines.append(row("Taux timeout",               "taux_timeout_pct",             "%", invert=True, fmt=".3f"))
    lines.append(row("Rentabilité recommandée",    "rentabilite_moyenne_recommandee_eur_h", "€/h"))
    lines.append(row("Rentabilité réalisée",       "rentabilite_realisee_eur_h",   "€/h"))
    lines.append(row("Écart renta. estimée/réelle","ecart_rentabilite_pct",        "%", invert=True))

    # ── Top 3 zones H3 par écart ──
    lines.append("\n---\n## 🗺️ Top 3 zones H3 — Plus grand écart de score composite\n")
    lines.append(
        "_Ces zones présentent le plus grand delta de score moyen entre les deux versions. "
        "Un delta négatif signifie que le nouveau modèle sous-performe sur cette zone._\n"
    )

    for i, z in enumerate(top3_zones, 1):
        delta_score_str = f"{z['delta_score']:+.4f}"
        trend = "📉 Régression" if z["is_regression"] else ("📈 Amélioration" if z["is_improvement"] else "➡️ Stable")

        lines.append(f"\n### #{i} — {z['label']}\n")
        lines.append(f"**Zone H3** : `{z['zone_h3']}` | **Tendance** : {trend}\n\n")
        lines.append(
            f"| Indicateur | v précédente | v courante | Delta |\n"
            f"|-----------|-------------|-----------|-------|\n"
            f"| Score composite moyen | `{z['score_prev']:.4f}` | `{z['score_curr']:.4f}` "
            f"| {fmt_delta_score(z['delta_score'])} |\n"
            f"| Écart-type score | `{z['std_prev']:.4f}` | `{z['std_curr']:.4f}` "
            f"| {fmt_delta_generic(z['std_curr'] - z['std_prev'], invert=True)} |\n"
            f"| Précision recommandation | — | — "
            f"| {fmt_delta_generic(z['delta_precision_pct'], '%')} |\n"
            f"| Rentabilité nette moy. | — | — | {fmt_delta_generic(z['delta_rentabilite_eur_h'], '€/h')} |\n"
            f"| Nb évaluations | `{z['nb_eval_prev']}` | `{z['nb_eval_curr']}` "
            f"| {fmt_delta_generic(z['nb_eval_curr'] - z['nb_eval_prev'], '')} |\n"
        )

        if z["is_regression"]:
            lines.append(
                f"\n> ⚠️ **Action requise** : la zone `{z['zone_h3']}` ({z['label']}) présente un écart "
                f"de score de `{delta_score_str}` — investiguer les features temporelles et "
                f"le ratio demande/offre sur cette zone avant le prochain cycle.\n"
            )

    # ── Régressions détectées ──
    if regressions:
        lines.append("\n---\n## 🚨 Régressions détectées\n")
        for r in regressions:
            lines.append(f"- ❌ {r}\n")
        lines.append(
            "\n> **Recommandation** : investiguer les changements de modèle entre "
            f"`{prev['version']}` et `{curr['version']}` avant le prochain déploiement. "
            "Envisager un rollback si la rentabilité réalisée continue de baisser.\n"
        )
    else:
        lines.append("\n---\n## ✅ Aucune régression critique détectée\n")
        lines.append(
            f"La version `{curr['version']}` maintient ou améliore les performances "
            f"de la version `{prev['version']}` sur toutes les métriques surveillées.\n"
        )

    # ── Pied de page ──
    lines.append(
        f"\n---\n"
        f"<sub>Rapport généré automatiquement par VTC ONE · "
        f"Seuils : MAPE +{SEUIL_REGRESSION_MAPE_PCT}pts | "
        f"Précision -{SEUIL_REGRESSION_PRECISION_PCT}pts | "
        f"Latence P95 +{SEUIL_REGRESSION_LATENCE_MS}ms | "
        f"Rentabilité -{SEUIL_REGRESSION_RENTABILITE}€/h | "
        f"Écart zone ≥{SEUIL_ECART_ZONE_SCORE}</sub>\n"
    )

    return "".join(lines)


# ─────────────────────────────────────────────────────────────────────────────
# Posting GitHub Issue
# ─────────────────────────────────────────────────────────────────────────────

def post_github_issue(
    repo: str,
    title: str,
    body: str,
    labels: list[str],
    dry_run: bool = False,
) -> Optional[str]:
    """
    Crée un GitHub Issue via `gh` CLI.
    Retourne l'URL de l'issue créée ou None en cas d'erreur.
    """
    if dry_run:
        print(f"[DRY RUN] Issue non créée — repo={repo} title={title!r}")
        return None

    label_args = []
    for label in labels:
        label_args += ["--label", label]

    cmd = [
        "gh", "issue", "create",
        "--repo", repo,
        "--title", title,
        "--body", body,
    ] + label_args

    try:
        result = subprocess.run(cmd, capture_output=True, text=True, timeout=30)
        if result.returncode == 0:
            url = result.stdout.strip()
            print(f"✅ GitHub Issue créée : {url}")
            return url
        else:
            # Labels manquants → retry sans labels
            print(f"⚠️ Erreur avec les labels ({result.stderr.strip()}) — retry sans labels")
            cmd_no_labels = [
                "gh", "issue", "create",
                "--repo", repo,
                "--title", title,
                "--body", body,
            ]
            result2 = subprocess.run(cmd_no_labels, capture_output=True, text=True, timeout=30)
            if result2.returncode == 0:
                url = result2.stdout.strip()
                print(f"✅ GitHub Issue créée (sans labels) : {url}")
                return url
            print(f"❌ Erreur création issue : {result2.stderr}")
            return None
    except subprocess.TimeoutExpired:
        print("❌ Timeout lors de la création de l'issue GitHub")
        return None
    except Exception as e:
        print(f"❌ Erreur inattendue : {e}")
        return None


def ensure_labels(repo: str, labels: list[tuple[str, str, str]]) -> None:
    """
    Crée les labels GitHub s'ils n'existent pas.
    labels = [(name, color_hex, description), ...]
    """
    for name, color, description in labels:
        cmd = [
            "gh", "label", "create", name,
            "--repo", repo,
            "--color", color,
            "--description", description,
            "--force",  # met à jour si déjà existant
        ]
        result = subprocess.run(cmd, capture_output=True, text=True, timeout=15)
        if result.returncode == 0:
            print(f"  Label '{name}' créé/mis à jour")
        else:
            print(f"  ⚠️ Label '{name}' : {result.stderr.strip()[:80]}")


# ─────────────────────────────────────────────────────────────────────────────
# Point d'entrée
# ─────────────────────────────────────────────────────────────────────────────

def main() -> int:
    parser = argparse.ArgumentParser(description="VTC ONE — Rapport de performance hebdomadaire")
    parser.add_argument(
        "--metrics-file", default="metrics/vtc_one_metrics.json",
        help="Chemin vers le fichier de métriques JSON"
    )
    parser.add_argument(
        "--repo", default="bamhamza86-wq/vtc-intelligence",
        help="Repo GitHub cible (owner/name)"
    )
    parser.add_argument(
        "--post-issue", action="store_true",
        help="Créer un GitHub Issue avec le rapport"
    )
    parser.add_argument(
        "--dry-run", action="store_true",
        help="Générer le rapport sans créer l'issue"
    )
    parser.add_argument(
        "--output", default="/tmp/vtc_one_report.md",
        help="Fichier de sortie du rapport Markdown"
    )
    args = parser.parse_args()

    print(f"📊 VTC ONE — Génération du rapport | {datetime.now(timezone.utc).isoformat()}")
    print(f"   Fichier métriques : {args.metrics_file}")
    print(f"   Repo cible        : {args.repo}\n")

    # Charger les métriques
    try:
        data = load_metrics(args.metrics_file)
    except (FileNotFoundError, ValueError) as e:
        print(f"❌ Erreur chargement métriques : {e}")
        return 1

    prev, curr = get_last_two_versions(data)
    print(f"   Comparaison : {prev['version']} → {curr['version']}")

    # Analyser les zones
    zone_deltas = analyze_zone_deltas(prev, curr)
    regressions = detect_global_regressions(prev, curr)

    # Générer le rapport
    report = generate_report(prev, curr, zone_deltas)

    # Sauvegarder
    with open(args.output, "w", encoding="utf-8") as f:
        f.write(report)
    print(f"   Rapport sauvegardé : {args.output}")

    # Afficher un résumé dans les logs
    print(f"\n{'═'*60}")
    print(f"  VERSION COURANTE : {curr['version']} ({curr['deployed_at'][:10]})")
    print(f"  RÉGRESSIONS GLOBALES : {len(regressions)}")
    print(f"  TOP 3 ZONES PAR ÉCART :")
    for i, z in enumerate(zone_deltas[:3], 1):
        trend = "📉" if z["is_regression"] else ("📈" if z["is_improvement"] else "➡️")
        print(f"    #{i} {trend} {z['label']} : {z['delta_score']:+.4f}")
    print(f"{'═'*60}\n")

    # Poster l'issue GitHub
    if args.post_issue:
        now = datetime.now(timezone.utc)
        week_num = now.isocalendar()[1]
        has_regression = len(regressions) > 0 or any(z["is_regression"] for z in zone_deltas[:3])
        prefix = "🔴 RÉGRESSION" if has_regression else "🟢 OK"

        title = (
            f"[VTC ONE] {prefix} — Rapport performance semaine {week_num} "
            f"({now.strftime('%d/%m/%Y')}) · v{prev['version']} → v{curr['version']}"
        )

        # Créer les labels si nécessaire
        ensure_labels(args.repo, [
            ("vtc-one:performance", "e11d48", "Rapport de performance VTC ONE"),
            ("vtc-one:regression",  "dc2626", "Régression détectée dans VTC ONE"),
            ("vtc-one:weekly",      "7c3aed", "Rapport hebdomadaire automatique"),
        ])

        labels = ["vtc-one:performance", "vtc-one:weekly"]
        if has_regression:
            labels.append("vtc-one:regression")

        issue_url = post_github_issue(
            repo=args.repo,
            title=title,
            body=report,
            labels=labels,
            dry_run=args.dry_run,
        )

        if issue_url:
            print(f"\n✅ Issue postée : {issue_url}")
            return 0
        elif args.dry_run:
            print("\n[DRY RUN] Rapport généré mais issue non créée.")
            return 0
        else:
            print("\n❌ Échec de la création de l'issue — rapport disponible dans " + args.output)
            return 1

    return 0


if __name__ == "__main__":
    sys.exit(main())
