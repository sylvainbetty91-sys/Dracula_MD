# Déploiement sur Render (gratuit)

## Étapes

1. Va sur https://render.com et crée un compte gratuit
2. Clique "New +" → "Web Service"
3. Choisis "Deploy from existing code" → Upload manuel OU connecte GitHub

### Option A - Via GitHub (recommandé)
1. Push ce dossier sur un repo GitHub privé
2. Sur Render, connecte ton GitHub et sélectionne le repo
3. Render détecte automatiquement Node.js

### Option B - Upload direct
1. Zippe ce dossier
2. Sur Render, utilise l'option "Manual Deploy"

## Configuration sur Render
- **Environment** : Node
- **Build Command** : `npm install`
- **Start Command** : `node index.js`
- **Instance Type** : Free

## Lien web
Render te donne un lien du genre :
https://mini-inconnu-xd-bot.onrender.com

Va sur : https://mini-inconnu-xd-bot.onrender.com/pair

## ⚠️ Limite du plan gratuit Render
Le serveur se "dort" après 15 min d'inactivité.
Il se réveille à la prochaine requête (délai ~30 sec).
Pour éviter ça, utilise https://uptimerobot.com (gratuit) pour ping ton URL toutes les 10 min.
