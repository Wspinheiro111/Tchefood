plugins {
    id("com.android.application")
}

// Sem TCHEFOOD_APP_URL o APK leva o Tchê Food embutido (build do Vite em ../dist) e funciona offline.
// Com TCHEFOOD_APP_URL=https://... o APK abre o sistema publicado nesse endereço (atualiza sem reinstalar).
val appUrl = providers.gradleProperty("TCHEFOOD_APP_URL").orNull?.trim()?.trimEnd('/').orEmpty()
if (appUrl.isNotEmpty() && !appUrl.startsWith("https://")) {
    throw GradleException("TCHEFOOD_APP_URL precisa ser https:// (as pontes de pagamento não podem ficar expostas a http)")
}
val bundleWebApp = appUrl.isEmpty()
val webDist = rootProject.layout.projectDirectory.dir("../dist")
val webAssetsRoot = layout.buildDirectory.dir("generated/webapp")

android {
    namespace = "food.tche.smartpos"
    compileSdk = 34

    defaultConfig {
        applicationId = "food.tche.smartpos"
        minSdk = 25
        targetSdk = 34
        versionCode = 1
        versionName = "0.1.0"
        buildConfigField("String", "TCHEFOOD_APP_URL", "\"$appUrl\"")
    }

    // pagbank: Moderninha Smart / SmartPOS PagBank, cobra pelo PlugPag dentro da máquina.
    // tablet: celular ou tablet Android comum, cobra pela nuvem (Stone Connect, Mercado Pago Point).
    flavorDimensions += "device"
    productFlavors {
        create("pagbank") {
            dimension = "device"
            manifestPlaceholders["appLabel"] = "Tchê Food"
        }
        create("tablet") {
            dimension = "device"
            applicationIdSuffix = ".tablet"
            manifestPlaceholders["appLabel"] = "Tchê Food"
        }
    }

    buildTypes {
        release {
            isMinifyEnabled = false
        }
    }

    buildFeatures {
        buildConfig = true
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }

    sourceSets["main"].assets.srcDir(webAssetsRoot)
}

val copyWebApp by tasks.registering(Copy::class) {
    description = "Copia o build web do Tchê Food (dist/) para os assets do APK em www/."
    enabled = bundleWebApp
    from(webDist)
    into(webAssetsRoot.map { it.dir("www") })
    doFirst {
        if (!webDist.file("index.html").asFile.exists()) {
            throw GradleException("Falta dist/index.html: rode `npm run build` na raiz do projeto antes do build do APK")
        }
    }
}

tasks.named("preBuild") { dependsOn(copyWebApp) }
tasks.matching { it.name.startsWith("merge") && it.name.endsWith("Assets") }.configureEach { dependsOn(copyWebApp) }

dependencies {
    implementation("androidx.webkit:webkit:1.11.0")
    implementation("androidx.annotation:annotation:1.8.0")
    "pagbankImplementation"("br.com.uol.pagseguro.plugpagservice.wrapper:wrapper:1.35.0")
}
