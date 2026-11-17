<div align="center">
  <img src="local_disk_analyzer/web/favicon.svg" width="88" height="88" alt="Logo Localdisk">
  <h1>Localdisk</h1>
  <p>Analyse ton disque. Fais de la place.</p>
  <p>
    <img src="https://img.shields.io/badge/plateforme-Windows%2064%20bits-ACEDD0?style=flat-square&amp;labelColor=26332D" alt="Windows 64 bits">
    <img src="https://img.shields.io/badge/application-portable-B9A7DE?style=flat-square&amp;labelColor=26332D" alt="Application portable">
    <img src="https://img.shields.io/badge/scan-C%3A%5C-9BBCEE?style=flat-square&amp;labelColor=26332D" alt="Scan de C:\">
    <img src="https://img.shields.io/badge/donn%C3%A9es-locales-E2BA82?style=flat-square&amp;labelColor=26332D" alt="Données locales">
  </p>
  <p>
    <a href="https://github.com/WaridoSann/localdiskscan/releases/download/windows-530dce7/LocalDiskAnalyzer-win-x64.zip"><img src="https://img.shields.io/badge/T%C3%89L%C3%89CHARGER-Windows%2064%20bits-ACEDD0?style=for-the-badge&amp;labelColor=26332D" alt="Télécharger pour Windows — application complète"></a>
  </p>
</div>

## Installer et lancer

1. Clique sur le bouton **TÉLÉCHARGER Windows 64 bits** ci-dessus.
2. Dans **Téléchargements**, fais clic droit sur **LocalDiskAnalyzer-win-x64.zip** → **Extraire tout…** → **Extraire**.
3. Ouvre le dossier extrait, puis le dossier **LocalDiskAnalyzer**, et double-clique sur **LocalDiskAnalyzer.exe** (type **Application**).

Le navigateur s’ouvre. Clique sur **Scanner C:\**.

**Pas besoin de Git, Python ou Node.js. Rien à taper dans PowerShell : l’application démarre elle-même son serveur local.**

## Aperçu

![Localdisk](docs/previews/fichiers.png)

<details>
<summary>Infos utiles et développement</summary>

- Garde le dossier `_internal` à côté de `LocalDiskAnalyzer.exe`. Extrais entièrement le ZIP avant de lancer l’application.
- Laisse l’application ouverte pendant le scan. Le serveur fonctionne uniquement sur ton ordinateur.
- L’interface ne propose aucune suppression. Les tailles sont logiques et les dossiers incluent leurs sous-dossiers.
- Cette préversion reprend le moteur compilé fourni et la nouvelle interface. Les tests navigateur utilisent une API simulée ; le paquet n’a pas été exécuté sous Windows dans l’environnement de préparation.
- L’aperçu utilise des données fictives. Les sources Python du moteur ne sont pas encore dans le dépôt ; le téléchargement Windows inclut son moteur compilé.

**Pour récupérer le code et tester l’interface — Node.js 20+ :**

```shell
git clone https://github.com/WaridoSann/localdiskscan.git
cd localdiskscan
npm ci
npx playwright install chromium
npm test
```

Ces commandes servent au développement de l’interface, pas au lancement de l’application Windows.

Références : [WinDirStat](https://github.com/windirstat/windirstat) · [gdu](https://github.com/dundee/gdu).

</details>
