#!/bin/sh
# index.html 의 <script id="core"> 블록만 뽑아낸다.
# 단일 HTML 파일을 유지하면서도 순수 로직을 Node 로 검증하기 위한 장치다.
#
# ^ 앵커가 중요하다. 앵커가 없으면 주석 안에 적힌 "<script id=\"core\">" 문자열에도
# sed 범위가 다시 걸려서 UI 블록까지 통째로 딸려온다(실제로 그랬다).
sed -n '/^<script id="core">$/,/^<\/script>$/p' "$(dirname "$0")/../index.html" | sed '1d;$d'
