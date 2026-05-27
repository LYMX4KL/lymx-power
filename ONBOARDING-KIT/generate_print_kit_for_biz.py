#!/usr/bin/env python3
"""LYMX storefront onboarding kit — per-business PDF generator.

Wraps generate_print_kit.py to bake a per-business QR code into all 30
PDFs (10 pieces × 3 languages). The base generator was authored with a
literal placeholder QR_URL so it had to run once per business with the
right URL injected; this script does that injection.

Usage:
    python3 generate_print_kit_for_biz.py \
        --biz-slug biz-oakline-kitchen \
        --biz-name "Oakline Kitchen" \
        --out-root /path/to/output

The QR encodes:
    https://getlymx.com/<biz_slug>?ref=qr

After running, /path/to/output/{en,es,zh-CN}/{NN-piece}_{lang}.pdf exists
for that business. Upload those to Supabase Storage at
    print-kit/<biz_slug>/<lang>/<NN-piece>.pdf
so biz-print-kit.html can link to them per-business.

Wired by ticket #06 (2026-05-27).
"""
import argparse, importlib, importlib.util, os, sys

THIS_DIR = os.path.dirname(os.path.abspath(__file__))
BASE_GEN_PATH = os.path.join(THIS_DIR, 'generate_print_kit.py')

def load_base_generator():
    """Import the sibling generate_print_kit.py as a module so we can
    monkey-patch its QR_URL and call main() without copy-pasting layout
    logic. Importing from a sibling path requires importlib because the
    folder isn't a package."""
    spec = importlib.util.spec_from_file_location('generate_print_kit', BASE_GEN_PATH)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod

def main():
    ap = argparse.ArgumentParser(description='Generate per-business LYMX print kit PDFs.')
    ap.add_argument('--biz-slug', required=True,
                    help='Canonical biz slug, e.g. biz-oakline-kitchen')
    ap.add_argument('--biz-name', default=None,
                    help='Display name for business card (optional; falls back to slug)')
    ap.add_argument('--owner-name', default=None,
                    help='Owner name for business card (optional; placeholder otherwise)')
    ap.add_argument('--out-root', required=True,
                    help='Root output folder. Subfolders en/, es/, zh-CN/ are created.')
    args = ap.parse_args()

    biz_slug = args.biz_slug.strip()
    if not biz_slug:
        print('FAIL: --biz-slug is empty', file=sys.stderr)
        sys.exit(2)

    # Real QR target. Keep ?ref=qr so we can attribute scan-driven traffic.
    qr_url = f'https://getlymx.com/{biz_slug}?ref=qr'

    gen = load_base_generator()

    # Patch the placeholder URL in the loaded module BEFORE main() runs.
    # The piece_* functions read gen.QR_URL at call time, so reassigning the
    # module attribute is sufficient — no need to re-execute the module.
    gen.QR_URL = qr_url

    # Optional: patch business-card display strings if owner/biz name supplied.
    # Business card piece reads COPY[lang]['card_biz'] and ['card_owner'].
    # These are placeholders ('<Business Name>', '<Owner Name>') by default
    # — fine to leave for partner-side printing, but if Kenny passes real
    # names we substitute them in.
    biz_display = args.biz_name or biz_slug.replace('-', ' ').replace('biz ', '').title()
    owner_display = args.owner_name  # may be None, then leave placeholder
    for lang in ['en', 'es', 'zh-CN']:
        if lang in gen.COPY:
            gen.COPY[lang]['card_biz'] = biz_display
            if owner_display:
                gen.COPY[lang]['card_owner'] = owner_display

    out_root = os.path.abspath(args.out_root)
    print(f'Generating print kit for "{biz_display}"')
    print(f'  biz_slug : {biz_slug}')
    print(f'  qr_url   : {qr_url}')
    print(f'  out_root : {out_root}')
    made = gen.main(out_root)
    print(f'OK — produced {len(made)} PDFs')

if __name__ == '__main__':
    main()
