import Header from './components/Header';
import Hero from './components/Hero';
import Beneficios from './components/Beneficios';
import Calculadora from './components/Calculadora';
import Comparativo from './components/Comparativo';
import Planos from './components/Planos';
import Faq from './components/Faq';
import CtaFinal from './components/CtaFinal';
import Rodape from './components/Rodape';
import WhatsAppFlutuante from './components/WhatsAppFlutuante';

export default function App() {
  return (
    <>
      <Header />
      <main>
        <Hero />
        <Beneficios />
        <Calculadora />
        <Comparativo />
        <Planos />
        <Faq />
        <CtaFinal />
      </main>
      <Rodape />
      <WhatsAppFlutuante />
    </>
  );
}
